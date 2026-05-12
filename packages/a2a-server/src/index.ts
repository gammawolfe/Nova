// packages/a2a-server/src/index.ts
//
// Wiring & assembly: middleware order, router mounts, server lifecycle.
// Route handlers live in routes/*.ts; the orchestration here is
// intentionally thin so the topology is readable in one screenful.

import express from 'express';
import path from 'path';
import type { ErrorRequestHandler } from 'express';
import { logger } from '@nova/shared/src/logger';
import { tenantRouter } from './tenant-router';
import { registerRouter } from './routes/register';
import { keyManager } from './key-manager';
import { streamRouter } from './stream';
import { inboxRouter } from './routes/inbox';
import { repliesRouter } from './routes/replies';
import { healthRouter } from './routes/health';
import { wellKnownRouter } from './routes/well-known';
import { discoverRouter } from './routes/discover';
import { tasksRouter } from './routes/tasks';
import { timedCheck, healthHandler } from '@nova/shared/src/health';
import { metricsHandler } from '@nova/shared/src/metrics';
import { a2aRegistry } from './metrics';
import { getSharedRedis } from '@nova/shared/src/redis';
import { createErrorMiddleware } from '@nova/shared/src/error-middleware';
import { KEY_ROOT } from '@nova/shared/src/tenant';
import { installShutdownHandlers } from './lifecycle';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const startTime = Date.now();

// H2 — Trust the front proxy (Caddy / nginx) so req.ip reflects the real
// client address. Without this, every rate-limit bucket collapses to the
// proxy's IP and per-sender throttling is effectively disabled. The exact
// value comes from NOVA_TRUST_PROXY: 'true', a numeric hop count, or a
// CIDR list. Defaults to 'loopback' so a misconfigured deploy doesn't
// silently honour spoofed X-Forwarded-For from the public internet.
//
// See: https://expressjs.com/en/guide/behind-proxies.html
const TRUST_PROXY = process.env.NOVA_TRUST_PROXY ?? 'loopback';
app.set('trust proxy', TRUST_PROXY === 'true' ? true : TRUST_PROXY);

// H2 — Default body limit of 64 KiB on every JSON ingress. Tasks with
// payload params occasionally include small attachments (URLs, base64
// thumbnails, structured params) so 64 KiB is comfortably above typical
// task envelopes while shutting the door on accidental megabyte uploads.
//
// The broker /respond endpoint uses a dedicated, larger limit applied at
// its own mount inside routes/inbox.ts.
app.use(express.json({ limit: '64kb' }));

// ── Service-level routes (no agent scoping) ────────────────────────────────

app.get('/health', healthHandler('a2a-server', startTime, async () => {
  const [redisCheck, keys] = await Promise.all([
    timedCheck(async () => {
      const pong = await getSharedRedis().ping();
      if (pong !== 'PONG') throw new Error('Redis ping failed');
    }),
    timedCheck(async () => {
      keyManager.getDid();
    }),
  ]);
  return { redis: redisCheck, keys };
}) as any);

app.get('/metrics', metricsHandler(a2aRegistry) as any);

app.use('/', discoverRouter);
app.use('/', wellKnownRouter);
app.use('/register', registerRouter);

// ── Broker-mode endpoints (self-UCAN auth — bypass tenantRouter) ──────────
//
// Mounted before agentRouter so the more specific /:agentId/inbox,
// /:agentId/replies, /:agentId/health paths win against the broader
// tenant middleware in agentRouter.
app.use('/agents', inboxRouter);
app.use('/agents', repliesRouter);
app.use('/agents', healthRouter);

// ── Per-agent routes (tenant middleware resolves req.ctx) ─────────────────

const agentRouter = express.Router({ mergeParams: true });
agentRouter.use(tenantRouter);
agentRouter.use(tasksRouter);
agentRouter.use(streamRouter);

app.use('/agents/:agentId', agentRouter);

// H2 — Global error middleware MUST be registered after every router so it
// catches both sync throws and rejected promises bubbled via next(err).
app.use(createErrorMiddleware({ logTag: 'a2a-server' }) as unknown as ErrorRequestHandler);

// ── Lifecycle ──────────────────────────────────────────────────────────────

let httpServer: ReturnType<typeof app.listen> | null = null;
installShutdownHandlers(() => httpServer);

async function start() {
  try {
    const keyPath = process.env.NOVA_PRIVATE_KEY_PATH
      || path.join(KEY_ROOT, 'nova.private.pem');
    await keyManager.initialize(keyPath);

    httpServer = app.listen(PORT, () => {
      logger.info(`🚀 Nova A2A Server running on http://localhost:${PORT}`);
      logger.info(`Identity DID: ${keyManager.getDid()}`);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start a2a-server');
    process.exit(1);
  }
}

start();
