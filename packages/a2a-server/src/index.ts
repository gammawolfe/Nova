import express from 'express';
import { logger } from '@nova/shared/src/logger';
import { executeGatePipeline, GateContext } from '@nova/gate-service';
import { enqueueWithIdempotency } from '@nova/task-queue';
import { QueuedTask } from '@nova/shared/src/types';
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

// Standard task ingress (Milestone 1 Stub)
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

    const status = gateResult.errorCode?.includes('UCAN') ? 401 : 403;
    
    return res.status(status).json({
      error: gateResult.errorCode,
      message: gateResult.reason
    });
  }

  // --- Map dynamically to Isolated Queue Buffer ---
  const generatedTaskId = req.body?.id || 'id-generation-fallback';
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
      // It hit our Redis SET NX lock — drop the request implicitly 
      // but still reply 202 because of asynchronous boundaries!
      logger.info({ taskId: generatedTaskId }, 'Dropped idempotent exact duplicate request at ingress');
    } else {
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
    const keyPath = process.env.NOVA_PRIVATE_KEY_PATH || 'data/keys/nova.private.pem';
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
