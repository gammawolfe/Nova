import express from 'express';
import { Router } from 'express';
import { logger } from '@nova/shared/src/logger';
import { adminAuth } from './middleware/auth';
import { errorHandler } from './middleware/error-handler';
import { tenantsRouter } from './routes/tenants';
import { agentsRouter } from './routes/agents';
import { trustRouter } from './routes/trust';
import { ucanRouter } from './routes/ucan';
import { quarantineRouter } from './routes/quarantine';
import { deadLetterRouter } from './routes/dead-letter';
import { confirmationRouter } from './routes/confirmation';
import { auditRouter } from './routes/audit';
import { systemRouter } from './routes/system';
import { discoverRouter } from './routes/discover';
import { UcanRenewSchema } from '@nova/shared/src/admin-schemas';
import * as ucanService from './services/ucan-service';
import * as nonceService from './services/nonce-service';

const app = express();
const PORT = process.env.PORT || 3005;

app.use(express.json());

// ── Public routes (no auth needed) ──────────────────────────────────────────
app.use('/discover', discoverRouter);

// UCAN renewal — proof-of-possession, not admin auth
const ucanRenewRouter = Router();

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

// ── Authenticated routes ────────────────────────────────────────────────────
app.use('/admin', adminAuth);

// Public healthcheck (no auth needed — already handled above)
app.get('/health', async (_req, res) => {
  try {
    const IORedis = (await import('ioredis')).default;
    const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
    const pong = await redis.ping();
    redis.quit();
    res.status(pong === 'PONG' ? 200 : 503).json({ status: pong === 'PONG' ? 'ok' : 'down', service: 'admin-api' });
  } catch {
    res.status(503).json({ status: 'down', service: 'admin-api' });
  }
});

// Mount routes per spec Section 5.5
app.use('/admin/tenants', tenantsRouter);
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
    const { closeRedis } = await import('./services/agent-service');
    await closeRedis();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
