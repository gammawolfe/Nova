import express from 'express';
import { logger } from '@nova/shared/src/logger';
import { executeGatePipeline, GateContext } from '@nova/gate-service';
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

    // 401 Unauthorized for Auth failures (missing/invalid tokens) vs 403 Forbidden (no access) vs 400 Bad Request
    const status = gateResult.errorCode?.includes('UCAN') ? 401 : 403;
    
    return res.status(status).json({
      error: gateResult.errorCode,
      message: gateResult.reason
    });
  }

  // TODO: Step 5 BullMQ Queue Enqueue step
  logger.info({ 
    ctx: req.ctx, 
    intent: req.body?.intent,
    senderDid: gateResult.senderDid,
    tier: gateResult.trustTier
  }, 'Task passed gate pipeline. Queueing...');

  // Specs explicitly dictate 202 Async ingestion standard
  res.status(202).json({
    status: 'submitted',
    taskId: req.body?.id || 'stubbed-task-id'
  });
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
