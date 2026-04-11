import IORedis from 'ioredis';
import { Worker, Job } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { queueName, TenantContext } from '@nova/shared/src/tenant';
import { QueuedTask } from '@nova/shared/src/types';
import { updateTaskStatus } from '@nova/task-queue/src/index';
import { deliverToOperator, deliverToReplyTo } from './delivery';
import { getOperatorUrl } from './config';

// Connect to Redis mapped externally in the docker-compose stack
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
export const redisConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

// Setup gracefully shutting down workers
const activeWorkers: Worker[] = [];

// For Milestone 1, we statically target the Seed config we generated
const MOCK_CTX: TenantContext = {
  tenantId: 'tenant_seed_123',
  agentId: 'agent_aria'
};

/**
 * Worker that dequeues tasks, delivers them to the operator,
 * collects results, and delivers results to the caller's replyTo URL.
 */
async function startWorker() {
  const targetedQueue = queueName(MOCK_CTX, 2);

  const worker = new Worker(targetedQueue, async (job: Job) => {
    const taskData = job.data as QueuedTask;
    const ctx: TenantContext = { tenantId: taskData.tenantId, agentId: taskData.agentId };

    logger.info({
      jobId: job.id,
      tenantId: taskData.tenantId,
      agentId: taskData.agentId,
      intent: taskData.intent,
      sender: taskData.senderDid
    }, 'Dequeued task for processing');

    // 1. Update state to 'working'
    await updateTaskStatus(ctx, taskData.taskId, 'working');

    // 2. Resolve operator URL from agent config
    const operatorUrl = getOperatorUrl(ctx);
    if (!operatorUrl) {
      logger.error({ ctx }, 'No operator URL configured for agent');
      await updateTaskStatus(ctx, taskData.taskId, 'failed', {
        statusMessage: 'No operator URL configured for agent',
      });
      return;
    }

    // 3. Deliver to operator and collect result
    const delivery = await deliverToOperator(operatorUrl, taskData);

    if (!delivery.success || !delivery.taskResult) {
      logger.error({ taskId: taskData.taskId, error: delivery.error }, 'Operator delivery failed');
      await updateTaskStatus(ctx, taskData.taskId, 'failed', {
        statusMessage: delivery.error || 'Operator delivery failed',
      });
      return;
    }

    // 4. Update state to completed with result
    await updateTaskStatus(ctx, taskData.taskId, 'completed', {
      result: delivery.taskResult,
    });

    logger.info({ taskId: taskData.taskId }, 'Task completed successfully');

    // 5. Deliver result to replyTo
    const replyResult = await deliverToReplyTo(taskData.replyTo, delivery.taskResult);
    if (!replyResult.success) {
      logger.warn({ taskId: taskData.taskId, error: replyResult.error },
        'replyTo delivery failed (no retry in M1)');
    } else {
      logger.info({ taskId: taskData.taskId }, 'Result delivered to replyTo');
    }
  }, { connection: redisConnection });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Worker execution failed');
  });

  worker.on('ready', () => {
    logger.info(`Agent Connector Worker listening on: ${targetedQueue}`);
  });

  activeWorkers.push(worker);
}

startWorker().catch(err => {
  logger.error('Worker failed to boot', err);
});

// Clean SIGTERM teardown
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
