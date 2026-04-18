import express from 'express';
import { Router } from 'express';
import path from 'path';
import { logger } from '@nova/shared/src/logger';
import { adminAuth } from './middleware/auth';
import { errorHandler } from './middleware/error-handler';
import { tenantsRouter } from './routes/tenants';
import { agentsRouter } from './routes/agents';
import { allAgentsRouter } from './routes/all-agents';
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
import { UcanRenewSchema, UcanRequestSchema } from '@nova/shared/src/admin-schemas';
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

// UCAN renewal — proof-of-possession, not admin auth
const ucanRenewRouter = Router({ mergeParams: true });

ucanRenewRouter.get('/', async (req, res) => {
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

ucanRenewRouter.post('/', async (req, res) => {
  try {
    const parseResult = UcanRenewSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'RENEW_INVALID',
        details: parseResult.error.issues.map((i: any) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const { tenantId } = req.params as { tenantId: string };
    const result = await ucanService.renewUcan(tenantId, parseResult.data);
    logger.info({ tenantId, did: parseResult.data.did, cid: result.cid }, 'UCAN renewed via proof-of-possession');
    res.status(200).json(result);
  } catch (err: any) {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  }
});

app.use('/admin/tenants/:tenantId/ucans/renew', ucanRenewRouter);

// UCAN request — cross-destination issuance via proof-of-possession
const ucanRequestRouter = Router({ mergeParams: true });
ucanRequestRouter.post('/', async (req, res) => {
  try {
    const parseResult = UcanRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'REQUEST_INVALID',
        details: parseResult.error.issues.map((i: any) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const { tenantId } = req.params as { tenantId: string };
    const result = await ucanService.requestUcan(tenantId, parseResult.data);
    logger.info(
      { sourceTenant: tenantId, sourceAgent: parseResult.data.agentId, destTenant: parseResult.data.destTenantId, destAgent: parseResult.data.destAgentId, cid: result.cid },
      'Cross-destination UCAN issued',
    );
    res.status(200).json(result);
  } catch (err: any) {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
  }
});
app.use('/admin/tenants/:tenantId/ucans/request', ucanRequestRouter);

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
app.use('/admin/tenants/:tenantId/invites', invitesRouter);
app.use('/admin/tenants/:tenantId/agents', agentsRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/trust', trustRouter);
app.use('/admin/tenants/:tenantId/ucans', ucanRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/quarantine', quarantineRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/dead-letter', deadLetterRouter);
app.use('/admin/tenants/:tenantId/agents/:agentId/confirm-queue', confirmationRouter);
app.use('/admin/tenants/:tenantId/audit', auditRouter);
app.use('/admin', systemRouter);

// Error handler must be last
app.use(errorHandler);

const server = app.listen(Number(PORT), '0.0.0.0', () => {
  logger.info(`Admin API running on http://127.0.0.1:${PORT}`);
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Admin API shutting down');
  server.close(async () => {
    const { closeSharedRedis } = await import('@nova/shared/src/redis');
    await closeSharedRedis();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
