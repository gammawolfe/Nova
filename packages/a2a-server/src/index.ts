import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { executeGatePipeline, GateContext } from '@nova/gate-service';
import { enqueueWithIdempotency, setTaskState, getTaskState, redis } from '@nova/task-queue/src/index';
import { QueuedTask, TaskState } from '@nova/shared/src/types';
import { AgentCardSchema } from '@nova/shared/src/schemas';
import { tenantDataPath, redisKey, DATA_ROOT } from '@nova/shared/src/tenant';
import { tenantRouter } from './tenant-router';
import { keyManager } from './key-manager';
import { streamRouter } from './stream';
import { timedCheck, aggregateHealth, HealthResponse } from '@nova/shared/src/health';
import { a2aRegistry } from './metrics';

const app = express();
const PORT = process.env.PORT || 3001;
const startTime = Date.now();

const RATE_LIMIT_PER_SENDER = parseInt(process.env.RATE_LIMIT_PER_SENDER || '60', 10);
const RATE_LIMIT_GLOBAL_PER_AGENT = parseInt(process.env.RATE_LIMIT_GLOBAL_PER_AGENT || '300', 10);

// Parse standard ingress objects
app.use(express.json());

// Health check with dependency probes
app.get('/health', (_req, res) => {
  (async () => {
    const checks = {
      redis: await timedCheck(async () => {
        const pong = await redis.ping();
        if (pong !== 'PONG') throw new Error('Redis ping failed');
      }),
      keys: await timedCheck(async () => {
        keyManager.getDid();
      }),
    };
    const status = aggregateHealth(checks);
    const response: HealthResponse = {
      status, service: 'a2a-server',
      uptime: Math.floor((Date.now() - startTime) / 1000), checks,
    };
    res.status(status === 'down' ? 503 : 200).json(response);
  })().catch(() => res.status(503).json({ status: 'down', service: 'a2a-server' }));
});

// Prometheus metrics
app.get('/metrics', (_req, res) => {
  a2aRegistry.metrics().then(metrics => {
    res.set('Content-Type', a2aRegistry.contentType);
    res.end(metrics);
  }).catch(() => res.status(500).end('Error collecting metrics'));
});

// A2A Protocol Routes
const agentRouter = express.Router({ mergeParams: true });
agentRouter.use(tenantRouter);

// Agent Card — public metadata about this agent
agentRouter.get('/.well-known/agent.json', async (req, res) => {
  try {
    const configPath = tenantDataPath(req.ctx, 'agent-config.json');
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
      skills: raw.skills || [],
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
    const senderCount = await redis.incr(senderKey);
    if (senderCount === 1) await redis.expire(senderKey, 60);

    if (senderCount > RATE_LIMIT_PER_SENDER) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }

    const globalKey = redisKey(ctx, 'rate', 'global');
    const globalCount = await redis.incr(globalKey);
    if (globalCount === 1) await redis.expire(globalKey, 60);

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
      const UCAN_CODES = new Set(['UCAN_MISSING', 'UCAN_INVALID_JWT', 'UCAN_EXPIRED', 'UCAN_REVOKED', 'UCAN_DID_MISMATCH', 'UCAN_WRONG_AUDIENCE', 'UCAN_INSUFFICIENT_CAPABILITY']);
      const status = UCAN_CODES.has(gateResult.errorCode!) ? 401 : 403;
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
  const queuedTask: QueuedTask = {
    taskId: generatedTaskId,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    intent: (req.body as any)?.intent || 'unknown_intent',
    params: (req.body as any)?.params || {},
    replyTo: (req.body as any)?.replyTo || 'https://unknown.reply.domain.com/webhook',
    senderDid: gateResult.senderDid!,
    tier: gateResult.trustTier!,
    queuedAt: new Date().toISOString(),
    expiresAt: (req.body as any)?.ttl ?? new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
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

app.use('/agents/:agentId', agentRouter);

async function start() {
  try {
    const keyPath = process.env.NOVA_PRIVATE_KEY_PATH
      || path.join(DATA_ROOT, 'keys', 'nova.private.pem');
    await keyManager.initialize(keyPath);

    app.listen(PORT, () => {
      logger.info(`🚀 Nova A2A Server running on http://localhost:${PORT}`);
      logger.info(`Identity DID: ${keyManager.getDid()}`);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start a2a-server');
    process.exit(1);
  }
}

start();
