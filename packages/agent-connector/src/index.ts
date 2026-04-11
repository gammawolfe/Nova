import IORedis from 'ioredis';
import { Worker, Job } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { queueName, TenantContext } from '@nova/shared/src/tenant';import { QueuedTask } from '@nova/shared/src/types';
import { updateTaskStatus, publishTaskEvent, redis as taskRedis } from '@nova/task-queue/src/index';
import { writeDeadLetter } from '@nova/task-queue/src/dead-letter';
import { deliverToOperator, deliverToReplyTo } from './delivery';
import { getOperatorUrl } from './config';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
export const redisConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const activeWorkers: Worker[] = [];

// Static context for M1/M2 — M4 will discover tenants dynamically
const MOCK_CTX: TenantContext = {
  tenantId: 'tenant_seed_123',
  agentId: 'agent_aria',
};

async function processTask(job: Job, ctx: TenantContext): Promise<void> {
  const task = job.data as QueuedTask;
  const taskCtx: TenantContext = { tenantId: task.tenantId, agentId: task.agentId };

  logger.info({ jobId: job.id, taskId: task.taskId, intent: task.intent }, 'Processing task');

  // Check TTL first
  if (new Date(task.expiresAt) <= new Date()) {
    await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'Task TTL expired before processing' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed', reason: 'TTL_EXPIRED' } });
    await auditLog(taskCtx, { event: 'task_expired', taskId: task.taskId });
    return;
  }

  // Task already passed all 5 gate layers (including LLM classification) before entering the queue.
  await updateTaskStatus(taskCtx, task.taskId, 'working');
  await publishTaskEvent(taskCtx, task.taskId, {
    type: 'status_update',
    data: { status: 'working' },
  });
  await auditLog(taskCtx, { event: 'task_started', taskId: task.taskId, tier: task.tier });

  const operatorUrl = getOperatorUrl(taskCtx);
  if (!operatorUrl) {
    logger.error({ taskCtx }, 'No operator URL configured for agent');
    await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'No operator URL configured' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed' } });
    return;
  }

  const delivery = await deliverToOperator(operatorUrl, task);

  if (!delivery.success || !delivery.taskResult) {
    const httpStatus = delivery.httpStatus ?? 0;

    // Write to dead letter for 4xx errors
    if (httpStatus >= 400 && httpStatus < 500) {
      const deadLetterId = writeDeadLetter(taskCtx, {
        taskId: task.taskId,
        targetUrl: operatorUrl,
        taskResult: {
          type: 'TaskResult',
          requestId: task.taskId,
          status: 'error',
          error: { code: 'DELIVERY_FAILED', message: delivery.error || 'HTTP 4xx', retryable: false },
          auditToken: 'none',
          completedAt: new Date().toISOString(),
          schemaVersion: '1.0',
        },
        failureReason: 'http_4xx',
        httpStatus,
        attemptCount: 1,
      });
      await auditLog(taskCtx, { event: 'dead_letter_written', taskId: task.taskId, metadata: { deadLetterId } });
      await auditLog(taskCtx, { event: 'delivery_permanent_failure', taskId: task.taskId, metadata: { httpStatus } });
    } else {
      await auditLog(taskCtx, { event: 'delivery_transient_failure', taskId: task.taskId, metadata: { error: delivery.error } });
    }

    await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: delivery.error || 'Delivery failed' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed' } });
    return;
  }

  // Update state to completed
  await updateTaskStatus(taskCtx, task.taskId, 'completed', { result: delivery.taskResult });
  await publishTaskEvent(taskCtx, task.taskId, {
    type: 'result',
    data: delivery.taskResult,
  });
  await auditLog(taskCtx, {
    event: 'task_completed',
    taskId: task.taskId,
    metadata: { status: delivery.taskResult.status },
  });

  logger.info({ taskId: task.taskId }, 'Task completed successfully');

  // Deliver result to replyTo
  const replyResult = await deliverToReplyTo(task.replyTo, delivery.taskResult);
  if (!replyResult.success) {
    logger.warn({ taskId: task.taskId, error: replyResult.error }, 'replyTo delivery failed');
    await auditLog(taskCtx, {
      event: 'delivery_transient_failure',
      taskId: task.taskId,
      metadata: { url: task.replyTo, error: replyResult.error },
    });
  } else {
    await auditLog(taskCtx, { event: 'delivery_success', taskId: task.taskId });
  }
}

async function startWorker() {
  const targetedQueue = queueName(MOCK_CTX, 2);

  const worker = new Worker(
    targetedQueue,
    async (job: Job) => processTask(job, MOCK_CTX),
    { connection: redisConnection, concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Worker job failed');
  });

  worker.on('ready', () => {
    logger.info(`Agent Connector Worker listening on: ${targetedQueue}`);
  });

  activeWorkers.push(worker);
}

startWorker().catch(err => {
  logger.error({ err }, 'Worker failed to boot');
  process.exit(1);
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down Agent Connector safely...');
  await Promise.all(activeWorkers.map(w => w.close()));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
