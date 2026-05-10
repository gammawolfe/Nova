import express from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { executeGatePipeline, GateContext } from '@nova/gate-service';
import { enqueueWithIdempotency, setTaskState, getTaskState, redis } from '@nova/task-queue/src/index';
import { QueuedTask, TaskState } from '@nova/shared/src/types';
import { AgentCardSchema } from '@nova/shared/src/schemas';
import { tenantDataPath, redisKey, DATA_ROOT, KEY_ROOT } from '@nova/shared/src/tenant';
import { tenantRouter } from './tenant-router';
import { registerRouter } from './routes/register';
import { keyManager } from './key-manager';
import { streamRouter } from './stream';
import { inboxRouter } from './routes/inbox';
import { repliesRouter } from './routes/replies';
import { healthRouter } from './routes/health';
import { wellKnownRouter } from './routes/well-known';
import { timedCheck, healthHandler } from '@nova/shared/src/health';
import { metricsHandler } from '@nova/shared/src/metrics';
import { a2aRegistry } from './metrics';
import { listActiveAgentMeta, getAgentMeta, getAgentByDid } from '@nova/shared/src/agent-index';
import { getSharedRedis, closeSharedRedis } from '@nova/shared/src/redis';
import { createErrorMiddleware } from '@nova/shared/src/error-middleware';
import type { ErrorRequestHandler } from 'express';
import { BROKER_RESULT_MAX_BYTES } from '@nova/shared/src/broker-config';
import { drainSseStreams, liveStreamCount } from './sse-registry';

const app = express();
const PORT = process.env.PORT || 3001;
const startTime = Date.now();

const RATE_LIMIT_PER_SENDER = parseInt(process.env.RATE_LIMIT_PER_SENDER || '60', 10);
const RATE_LIMIT_GLOBAL_PER_AGENT = parseInt(process.env.RATE_LIMIT_GLOBAL_PER_AGENT || '300', 10);

const UCAN_ERROR_CODES = new Set(['UCAN_MISSING', 'UCAN_INVALID_JWT', 'UCAN_EXPIRED', 'UCAN_REVOKED', 'UCAN_DID_MISMATCH', 'UCAN_WRONG_AUDIENCE', 'UCAN_INSUFFICIENT_CAPABILITY']);

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
// its own mount below — TaskResults can include arbitrary user payloads
// up to BROKER_RESULT_MAX_BYTES (default 1 MiB).
app.use(express.json({ limit: '64kb' }));

app.get('/health', healthHandler('a2a-server', startTime, async () => {
  const [redisCheck, keys] = await Promise.all([
    timedCheck(async () => {
      const pong = await redis.ping();
      if (pong !== 'PONG') throw new Error('Redis ping failed');
    }),
    timedCheck(async () => {
      keyManager.getDid();
    }),
  ]);
  return { redis: redisCheck, keys };
}) as any);

app.get('/metrics', metricsHandler(a2aRegistry) as any);

app.get('/discover', async (req, res) => {
  try {
    const redis = getSharedRedis();
    let agents = await listActiveAgentMeta(redis);

    const statusFilter = req.query.status as string;
    if (statusFilter && statusFilter !== 'all') {
      agents = agents.filter(agent => agent.status === statusFilter);
    }

    const skillsFilter = req.query.skills as string;
    if (skillsFilter) {
      agents = agents.filter(agent =>
        agent.skills.some(skill =>
          skill.id.includes(skillsFilter) ||
          skill.name.includes(skillsFilter) ||
          (skill.tags && skill.tags.includes(skillsFilter))
        )
      );
    }
    res.json(agents);
  } catch (err) {
    logger.error({ err }, 'Failed to list agents for discovery');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve agent list' });
  }
});

app.get('/discover/:agentId', async (req, res) => {
  try {
    const redis = getSharedRedis();
    const agent = await getAgentMeta(redis, req.params.agentId);
    if (!agent) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND', message: `Agent ${req.params.agentId} not found` });
    }
    res.json(agent);
  } catch (err) {
    logger.error({ err }, `Failed to retrieve agent ${req.params.agentId}`);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve agent details' });
  }
});

// A2A Protocol Routes
const agentRouter = express.Router({ mergeParams: true });
agentRouter.use(tenantRouter);

// H2 — helmet on the public well-known agent card. The card is the only
// truly public-by-design surface (every other route gates on UCAN, self-
// UCAN, or admin token), so a strict default header set is appropriate
// here without weakening the rest of the API. Specifically we set:
//   - Content-Security-Policy default-src 'none' (no scripts, no images)
//   - X-Content-Type-Options: nosniff
//   - X-Frame-Options: DENY
//   - Referrer-Policy: no-referrer
const wellKnownHelmet = helmet({
  contentSecurityPolicy: { directives: { 'default-src': ["'none'"] } },
  crossOriginEmbedderPolicy: false, // not relevant for a JSON endpoint
});

// Agent Card — public metadata about this agent
agentRouter.get('/.well-known/agent.json', wellKnownHelmet, async (req, res) => {
  try {
    const configPath = tenantDataPath(req.ctx, 'agent-config.json');
    let raw: any;
    try {
      raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    } catch {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const card = {
      name: raw.name,
      description: raw.description,
      url: `${req.protocol}://${req.get('host')}/agents/${req.ctx.agentId}`,
      version: raw.version || '1.0.0',
      protocolVersions: ['1.0'] as const,
      capabilities: raw.capabilities || {
        streaming: true,
        pushNotifications: true,
        stateTransitionHistory: true,
      },
      authentication: raw.authentication || {
        schemes: ['ucan'],
        ucapabilityPrefix: `nova:${req.ctx.tenantId}:${req.ctx.agentId}`,
      },
      skills: (raw.skills || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags ?? [],
        inputSchema: s.inputSchema ?? {},
        outputSchema: s.outputSchema ?? {},
      })),
    };

    const parsed = AgentCardSchema.safeParse(card);
    if (!parsed.success) {
      logger.error({ errors: parsed.error.issues }, 'Agent card validation failed');
      return res.status(500).json({ error: 'Invalid agent configuration' });
    }

    res.json(parsed.data);
  } catch (err) {
    logger.error({ err }, 'Failed to serve agent card');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Task Status — query current state of a submitted task
agentRouter.get('/tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;
  try {
    const state = await getTaskState(req.ctx, taskId);
    if (!state) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(state);
  } catch (err) {
    logger.error({ err, taskId }, 'Failed to fetch task state');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// SSE Streaming endpoint
agentRouter.use(streamRouter);

// Standard task ingress
agentRouter.post('/tasks', async (req, res) => {
  const ctx = req.ctx;
  const requestId = crypto.randomUUID();

  // --- Rate Limiting (per-sender IP + global per-agent) ---
  const senderIp = req.ip ?? '0.0.0.0';
  try {
    const senderKey = redisKey(ctx, 'rate', 'sender', senderIp);
    const globalKey = redisKey(ctx, 'rate', 'global');

    const pipe = redis.pipeline();
    pipe.incr(senderKey);
    pipe.expire(senderKey, 60);
    pipe.incr(globalKey);
    pipe.expire(globalKey, 60);
    const results = await pipe.exec();

    const senderCount = (results?.[0]?.[1] as number) ?? 0;
    const globalCount = (results?.[2]?.[1] as number) ?? 0;

    if (senderCount > RATE_LIMIT_PER_SENDER) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }

    if (globalCount > RATE_LIMIT_GLOBAL_PER_AGENT) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
  } catch (err) {
    // Redis unavailable — spec says return 503
    logger.error({ err }, 'Redis unavailable during rate limit check');
    return res.status(503).json({ error: 'INTERNAL_ERROR', message: 'Service temporarily unavailable' });
  }

  // --- Audit: message_received ---
  try {
    await auditLog(ctx, {
      event: 'message_received',
      senderDid: undefined,
      metadata: { requestId, senderIp },
    });
  } catch (err) {
    // Audit write failed — spec says return 503
    logger.error({ err }, 'Audit log write failed at ingress');
    return res.status(503).json({ error: 'INTERNAL_ERROR', message: 'Audit system unavailable' });
  }

  // --- Gate Pipeline ---
  const gateCtx: GateContext = {
    tenantCtx: ctx,
    headers: req.headers,
    body: req.body,
    senderIp,
    requestId,
    agentDid: keyManager.getDid(),
  };

  const gateResult = await executeGatePipeline(gateCtx);

  if (!gateResult.passed) {
    logger.warn({
      ctx,
      error: gateResult.errorCode,
      reason: gateResult.reason,
      decision: gateResult.decision,
    }, 'Task rejected at ingress gate');

    // Quarantined tasks still return 202 (gate decision is internal)
    // Dropped tasks return error codes
    if (gateResult.decision === 'dropped') {
      const status = UCAN_ERROR_CODES.has(gateResult.errorCode!) ? 401 : 403;
      return res.status(status).json({
        error: gateResult.errorCode,
        message: gateResult.reason,
      });
    }

    // Quarantined — return 202 with quarantine context (operator can review)
    return res.status(202).json({
      status: 'quarantined',
      reason: gateResult.reason,
      quarantineId: gateResult.quarantineId,
    });
  }

  // --- Map to Queue ---
  const generatedTaskId = crypto.randomUUID();
  const parsed = gateResult.parsedTask as { intent?: string; params?: Record<string, unknown>; replyTo?: string; ttl?: string } | undefined;

  // Sender resolution: map the verified senderDid to a Nova-registered agent
  // so broker-mode reply routing works when replyTo is omitted. Unregistered
  // senders (external callers) are still accepted as long as replyTo is set.
  let senderTenantId: string | undefined;
  let senderAgentId: string | undefined;
  if (gateResult.senderDid) {
    try {
      const senderAgent = await getAgentByDid(getSharedRedis(), gateResult.senderDid);
      if (senderAgent && senderAgent.status === 'active') {
        senderTenantId = senderAgent.tenantId;
        senderAgentId = senderAgent.agentId;
      }
    } catch (err: any) {
      logger.warn({ err: err.message, senderDid: gateResult.senderDid }, 'Sender DID lookup failed; continuing without sender resolution');
    }
  }

  if (!parsed?.replyTo && !senderAgentId) {
    return res.status(400).json({
      error: 'REPLY_TARGET_UNRESOLVED',
      message: 'Task has no replyTo URL and sender DID is not a registered Nova agent; result would be undeliverable',
    });
  }

  const queuedTask: QueuedTask = {
    taskId: generatedTaskId,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    intent: parsed?.intent || 'unknown_intent',
    params: parsed?.params || {},
    ...(parsed?.replyTo ? { replyTo: parsed.replyTo } : {}),
    ...(senderTenantId ? { senderTenantId } : {}),
    ...(senderAgentId ? { senderAgentId } : {}),
    senderDid: gateResult.senderDid!,
    tier: gateResult.trustTier!,
    queuedAt: new Date().toISOString(),
    expiresAt: parsed?.ttl ?? new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
  };

  try {
    const queued = await enqueueWithIdempotency(ctx, queuedTask, 600);

    if (!queued) {
      logger.info({ taskId: generatedTaskId }, 'Dropped idempotent duplicate request');
    } else {
      const initialState: TaskState = {
        taskId: generatedTaskId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        status: 'submitted',
        intent: queuedTask.intent,
        submittedAt: queuedTask.queuedAt,
        updatedAt: queuedTask.queuedAt,
        expiresAt: queuedTask.expiresAt,
        submitterDid: gateResult.senderDid!,
      };
      await setTaskState(ctx, initialState);

      await auditLog(ctx, {
        event: 'task_queued',
        taskId: generatedTaskId,
        senderDid: gateResult.senderDid,
        tier: gateResult.trustTier,
      });

      logger.info({
        ctx,
        taskId: generatedTaskId,
        senderDid: gateResult.senderDid,
        tier: gateResult.trustTier,
      }, 'Task passed gate pipeline and enqueued');
    }

    const host = req.get('host');
    const baseUrl = `${req.protocol}://${host}/agents/${ctx.agentId}`;

    return res.status(202).json({
      status: 'submitted',
      taskId: generatedTaskId,
      statusUrl: `${baseUrl}/tasks/${generatedTaskId}`,
      streamUrl: `${baseUrl}/tasks/${generatedTaskId}/stream`,
    });

  } catch (err: any) {
    logger.error({ err, taskId: generatedTaskId }, 'Queue failure at ingress');
    return res.status(503).json({ error: 'INTERNAL_ERROR', message: 'Task queue backend temporarily unavailable' });
  }
});

// Self-registration endpoint (public, no auth, outside agent routing)
app.use('/', wellKnownRouter);
app.use('/register', registerRouter);

// Broker inbox pull endpoints — mounted before agentRouter so /:agentId/inbox
// routes take priority over the tenantRouter middleware in agentRouter.
app.use('/agents', inboxRouter);

// Broker reply inbox — symmetric to inboxRouter. Handles result collection
// for broker-mode senders. Also mounted before agentRouter to bypass tenant
// middleware, since self-UCAN auth is the access gate here.
app.use('/agents', repliesRouter);

// Public status probe — mounted before agentRouter for the same tenant-
// middleware-bypass reason. Advisory pre-flight check used by MCP clients
// to catch operator revocations before sending tasks.
app.use('/agents', healthRouter);

app.use('/agents/:agentId', agentRouter);

// H2 — Global error middleware MUST be registered after every router so it
// catches both sync throws and rejected promises bubbled via next(err). It
// maps ZodError, NovaError, and {status, message} shapes the same way the
// admin-api does, with a couple of a2a-specific code-to-status overrides.
app.use(createErrorMiddleware({
  logTag: 'a2a-server',
  statusOverrides: {
    // a2a-server returns 503 specifically for backend-availability issues
    // so the gate code-to-status map can stay 'standard'. Add overrides
    // here only when the service-specific status differs from the default.
  },
}) as unknown as ErrorRequestHandler);

// ────────────────────────────────────────────────────────────────────────────
// H1 — Graceful shutdown.
//
// On SIGTERM/SIGINT:
//   1. Stop accepting new HTTP connections (server.close)
//   2. Drain every live SSE stream — each cleanup tells its Redis subscriber
//      to unsubscribe + quit, clears its heartbeat, and lets the response
//      end cleanly. Without this step, clients get an abrupt TCP RST
//      mid-stream when the process exits.
//   3. Close the shared Redis client (publishers, queues, indexes)
//   4. exit(0)
//
// A safety timer guarantees exit even if `server.close` hangs on a stuck
// keep-alive socket; without it, an idle long-poll could pin the process
// until OS-level kill.
// ────────────────────────────────────────────────────────────────────────────

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.NOVA_SHUTDOWN_TIMEOUT_MS ?? '15000', 10);
let shuttingDown = false;
let httpServer: ReturnType<typeof app.listen> | null = null;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, liveStreams: liveStreamCount() }, 'a2a-server shutting down');

  // Hard exit if anything below hangs.
  const watchdog = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'a2a-server shutdown watchdog fired — exiting hard');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  try {
    // 1. stop accepting new connections
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close((err) => {
          if (err) logger.warn({ err }, 'server.close reported an error');
          resolve();
        });
      });
    }

    // 2. drain live SSE streams (idempotent with each handler's own cleanup)
    const drained = drainSseStreams();
    if (drained > 0) {
      logger.info({ drained }, 'Drained SSE streams during shutdown');
      // Brief grace period for Redis unsubscribe/quit acks to flush before
      // we close the shared client below.
      await new Promise(r => setTimeout(r, 250));
    }

    // 3. close shared Redis (publishers, queues, indexes used by handlers)
    await closeSharedRedis();

    logger.info('a2a-server shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown sequence');
  } finally {
    clearTimeout(watchdog);
    process.exit(0);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });

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
