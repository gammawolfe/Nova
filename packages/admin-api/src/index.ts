// Fail fast on missing/weak ADMIN_TOKEN — throws before the server binds.
import './config';

import express from 'express';
import { Router } from 'express';
import path from 'path';
import { logger } from '@nova/shared/src/logger';
import { adminAuth } from './middleware/auth';
import { createErrorMiddleware } from '@nova/shared/src/error-middleware';
import { tenantsRouter } from './routes/tenants';
import { agentsRouter } from './routes/agents';
import { allAgentsRouter } from './routes/all-agents';
import { allAuditRouter } from './routes/all-audit';
import { trustRouter } from './routes/trust';
import { ucanRouter } from './routes/ucan';
import { quarantineRouter } from './routes/quarantine';
import { deadLetterRouter } from './routes/dead-letter';
import { confirmationRouter } from './routes/confirmation';
import { auditRouter } from './routes/audit';
import { systemRouter } from './routes/system';
import { discoverRouter } from './routes/discover';
import { invitesRouter } from './routes/invites';
import { eventsRouter } from './routes/events';
import { brokerStatusRouter, brokerSummaryRouter } from './routes/broker';
import { federationRouter } from './routes/federation';
import { AgentRotateKeySchema } from '@nova/shared/src/admin-schemas';
import { healthHandler, timedCheck } from '@nova/shared/src/health';
import { getSharedRedis } from '@nova/shared/src/redis';
import * as ucanService from './services/ucan-service';
import * as nonceService from './services/nonce-service';

const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json());

// ── UI static assets (unauthenticated; bearer auth is on /admin/* only) ────
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  maxAge: '5m',
}));

// ── Public routes (no auth needed) ──────────────────────────────────────────
app.use('/discover', discoverRouter);

// Note: /ucans/renew and /ucans/request were removed when Nova dropped the
// notary-model UCANs. Senders now mint invocation tokens locally with their
// own Ed25519 key; the approval grant (issued at operator approval) is the
// only Nova-signed UCAN in the chain. Grant renewal goes through /ucans/
// reissue (operator admin auth) — see routes/agents.ts:ucans/reissue.
//
// The nonce issuance endpoint below is still needed for key rotation, which
// PoP-signs the new identity with the old private key.
const nonceRouter = Router({ mergeParams: true });
nonceRouter.get('/', async (req, res) => {
  try {
    const did = req.query.did as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    if (!did || !agentId) {
      return res.status(400).json({ error: 'MISSING_PARAMS', message: 'did and agentId required' });
    }
    const { nonce, expiresAt } = nonceService.createNonce(did, agentId);
    res.json({ nonce, expiresAt });
  } catch (err: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});
app.use('/admin/tenants/:tenantId/nonces', nonceRouter);

// Agent key rotation — proof-of-possession of OLD key; no admin auth.
// Mounted before the /admin adminAuth gate (same trick as ucans/renew) —
// the URL lives under /admin/... for namespace consistency but the auth
// boundary is the PoP signature, not the bearer token.
const rotateKeyRouter = Router({ mergeParams: true });
rotateKeyRouter.post('/', async (req, res) => {
  try {
    const parseResult = AgentRotateKeySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'ROTATE_INVALID',
        details: parseResult.error.issues.map((i: any) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const { tenantId, agentId } = req.params as { tenantId: string; agentId: string };
    const result = await ucanService.rotateAgentKey(tenantId, agentId, parseResult.data);
    logger.info(
      { tenantId, agentId, oldDid: parseResult.data.oldDid, newDid: result.newDid, revokedCount: result.revokedCids.length },
      'Agent key rotated via proof-of-possession',
    );
    res.status(200).json(result);
  } catch (err: any) {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  }
});
app.use('/admin/tenants/:tenantId/agents/:agentId/rotate-key', rotateKeyRouter);

// ── SSE lifecycle events (unauthenticated; browser EventSource has no header API; v1 trust model is localhost) ──
app.use('/admin/events', eventsRouter);

// ── Authenticated routes ────────────────────────────────────────────────────
app.use('/admin', adminAuth);

// Lightweight liveness probe (no auth, reuses shared Redis connection)
const adminStartTime = Date.now();
app.get('/health', healthHandler('admin-api', adminStartTime, async () => ({
  redis: await timedCheck(async () => {
    const pong = await getSharedRedis().ping();
    if (pong !== 'PONG') throw new Error('Redis ping failed');
  }),
})) as any);

// Mount routes per spec Section 5.5
app.use('/admin/tenants', tenantsRouter);
app.use('/admin/agents', allAgentsRouter);
app.use('/admin/audit', allAuditRouter);
app.use('/admin/tenants/:tenantId/invites', invitesRouter);
app.use('/admin/tenants/:tenantId/agents', agentsRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/trust', trustRouter);
app.use('/admin/tenants/:tenantId/ucans', ucanRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/quarantine', quarantineRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/dead-letter', deadLetterRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/confirm-queue', confirmationRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/broker-status', brokerStatusRouter);
app.use('/admin/tenants/:tenantId/audit', auditRouter);
app.use('/admin/broker', brokerSummaryRouter);
app.use('/admin/federation', federationRouter);
app.use('/admin', systemRouter);

// Error handler must be last
app.use(createErrorMiddleware({ logTag: 'admin-api' }));

const server = app.listen(Number(PORT), '0.0.0.0', () => {
  logger.info(`Admin API running on http://127.0.0.1:${PORT}`);
});

// Graceful shutdown — watchdog forces exit if server.close hangs on a
// stuck keep-alive; idempotent so a SIGINT-then-SIGTERM doesn't race.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.NOVA_SHUTDOWN_TIMEOUT_MS ?? '15000', 10);
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Admin API shutting down');

  const watchdog = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'admin-api shutdown watchdog fired — exiting hard');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  try {
    await new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) logger.warn({ err }, 'server.close reported an error');
        resolve();
      });
    });
    const { closeSharedRedis } = await import('@nova/shared/src/redis');
    await closeSharedRedis();
    logger.info('admin-api shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown sequence');
  } finally {
    clearTimeout(watchdog);
    process.exit(0);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
