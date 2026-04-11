import express from 'express';
import { logger } from '@nova/shared/src/logger';
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
  // TODO: Step 5 Gate pipeline ingestion + BullMQ Queue
  logger.info({ 
    ctx: req.ctx, 
    intent: req.body?.intent 
  }, 'Ingested primitive A2A task layout');

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
