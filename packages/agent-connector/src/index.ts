import IORedis from 'ioredis';
import { Worker, Job } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { queueName, TenantContext } from '@nova/shared/src/tenant';
import { QueuedTask } from '@nova/shared/src/types';

// Connect to Redis mapped externally in the docker-compose stack
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
export const redisConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

// Setup gracefully shutting down workers
const activeWorkers: Worker[] = [];

// For Milford 1, we statically target the Seed config we generated
const MOCK_CTX: TenantContext = {
  tenantId: 'tenant_seed_123',
  agentId: 'agent_aria'
};

/**
 * Dispatches simulated processor for Mock Tier 2 queue.
 */
async function startWorker() {
  const targetedQueue = queueName(MOCK_CTX, 2);

  const worker = new Worker(targetedQueue, async (job: Job) => {
    const taskData = job.data as QueuedTask;

    logger.info({
      jobId: job.id,
      tenantId: taskData.tenantId,
      agentId: taskData.agentId,
      intent: taskData.intent,
      sender: taskData.senderDid
    }, `[AGENT CONNECTOR] Dequeued payload for delivery!`);

    // --- STEP 0: Async LLM Injection Classification (Mocked) ---
    logger.info(`[AGENT CONNECTOR] Passed Async LLM Injection Analysis stage for Task: ${taskData.taskId}`);

    // --- STEP: Delivery Module (Mocked) ---
    logger.info(`[AGENT CONNECTOR] Simulated delivering task to Operator URL: ${taskData.replyTo}`);
    
    return { success: true, timestamp: new Date().toISOString() };
  }, { connection: redisConnection });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Worker execution failed');
  });

  worker.on('ready', () => {
    logger.info(`✅ Agent Connector Worker booted up! Listening continuously on: ${targetedQueue}`);
  });

  activeWorkers.push(worker);
}

startWorker().catch(err => {
  logger.error('Worker failed to boot', err);
});

// Clean SIGTERM teardown mapped in the architecture guidelines
process.on('SIGINT', async () => {
  logger.info('Shutting down Agent Connector safely...');
  await Promise.all(activeWorkers.map(w => w.close()));
  process.exit(0);
});
process.on('SIGTERM', async () => {
  logger.info('Shutting down Agent Connector safely...');
  await Promise.all(activeWorkers.map(w => w.close()));
  process.exit(0);
});
