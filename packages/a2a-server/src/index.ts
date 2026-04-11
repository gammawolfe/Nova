import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '@nova/shared/src/logger';
import { executeGatePipeline, GateContext } from '@nova/gate-service';
import { enqueueWithIdempotency, setTaskState, getTaskState } from '@nova/task-queue/src/index';
import { QueuedTask, TaskState } from '@nova/shared/src/types';
import { AgentCardSchema } from '@nova/shared/src/schemas';
import { tenantDataPath } from '@nova/shared/src/tenant';
import { tenantRouter } from './tenant-router';
import { keyManager } from './key-manager';

const app = express();
const PORT = process.env.PORT || 3001;

// Parse standard ingress objects
app.use(express.json());

// Standard Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', did: keyManager.getDid() });
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
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
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

// Standard task ingress
agentRouter.post('/tasks', async (req, res) => {
  const gateCtx: GateContext = {
    tenantCtx: req.ctx,
    headers: req.headers,
    body: req.body
  };

  // Synchronously execute the Gate Pipeline blocking admission
  const gateResult = await executeGatePipeline(gateCtx);

  if (!gateResult.passed) {
    logger.warn({ 
      ctx: req.ctx, 
      error: gateResult.errorCode, 
      reason: gateResult.reason 
    }, 'Task rejected at ingress gate');

    const UCAN_ERROR_CODES = new Set(['UCAN_MISSING', 'UCAN_INVALID_JWT', 'UCAN_EXPIRED', 'UCAN_REVOKED', 'UCAN_DID_MISMATCH', 'UCAN_INSUFFICIENT_CAPABILITY']);
    const status = UCAN_ERROR_CODES.has(gateResult.errorCode!) ? 401 : 403;
    
    return res.status(status).json({
      error: gateResult.errorCode,
      message: gateResult.reason
    });
  }

  // --- Map dynamically to Isolated Queue Buffer ---
  // Generate task ID server-side; use client's idempotencyKey only for dedup
  const generatedTaskId = crypto.randomUUID();
  const queuedTaskFormat: QueuedTask = {
    taskId: generatedTaskId,
    tenantId: req.ctx.tenantId,
    agentId: req.ctx.agentId,
    intent: req.body?.intent || 'unknown_intent',
    params: req.body?.params || {},
    replyTo: req.body?.replyTo || 'https://unknown.reply.domain.com/webhook',
    senderDid: gateResult.senderDid!,
    tier: gateResult.trustTier!,
    queuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString() // 24h fallback
  };

  try {
    // We invoke our custom idempotent BullMQ wrapper directly as designed
    // Wait TTL is 600 seconds (10 mins) as defined implicitly
    const queued = await enqueueWithIdempotency(req.ctx, queuedTaskFormat, 600);

    if (!queued) {
      logger.info({ taskId: generatedTaskId }, 'Dropped idempotent exact duplicate request at ingress');
    } else {
      // Persist initial task state for status queries
      const initialState: TaskState = {
        taskId: generatedTaskId,
        tenantId: req.ctx.tenantId,
        agentId: req.ctx.agentId,
        status: 'submitted',
        intent: queuedTaskFormat.intent,
        submittedAt: queuedTaskFormat.queuedAt,
        updatedAt: queuedTaskFormat.queuedAt,
        expiresAt: queuedTaskFormat.expiresAt,
        submitterDid: gateResult.senderDid!,
      };
      await setTaskState(req.ctx, initialState);

      logger.info({
        ctx: req.ctx,
        taskId: generatedTaskId,
        senderDid: gateResult.senderDid,
        tier: gateResult.trustTier
      }, 'Task passed gate pipeline. BullMQ enqueue successful!');
    }

    // Specs explicitly dictate 202 Async ingestion standard
    res.status(202).json({
      status: 'submitted',
      taskId: generatedTaskId
    });

  } catch (err: any) {
    logger.error({ err, taskId: generatedTaskId }, 'Redis Queueing Failure at boundaries');
    res.status(503).json({ error: 'INTERNAL_ERROR', message: 'Task queue backend is temporarily unavailable' });
  }
});

app.use('/agents/:agentId', agentRouter);

async function start() {
  try {
    // 1. Initialize cryptographic boundary 
    // Accounts for npm workspaces running nested directory CWDs
    const keyPath = process.env.NOVA_PRIVATE_KEY_PATH || path.resolve(process.cwd(), '../../data/keys/nova.private.pem');
    await keyManager.initialize(keyPath);

    app.listen(PORT, () => {
      logger.info(`🚀 Nova A2A Server running on http://localhost:${PORT}`);
      logger.info(`Identity Bound to DID: ${keyManager.getDid()}`);
    });
  } catch (err) {
    logger.error('Failed to start a2a-server', err);
    process.exit(1);
  }
}

start();
