import express from 'express';
import IORedis from 'ioredis';
import { Worker, Job } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { queueName, TenantContext } from '@nova/shared/src/tenant';
import { QueuedTask } from '@nova/shared/src/types';
import { updateTaskStatus, publishTaskEvent, redis as taskRedis } from '@nova/task-queue/src/index';
import { writeDeadLetter } from '@nova/task-queue/src/dead-letter';
import { timedCheck, aggregateHealth, HealthResponse } from '@nova/shared/src/health';
import { deliverToOperator, deliverToReplyTo } from './delivery';
import { getOperatorUrl } from './config';
import { connectorRegistry, deliveryOutcomes } from './metrics';
import { requiresConfirmation, createConfirmRequest, waitForConfirmation } from './confirmation';

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

  // --- Confirmation Gate for High-Privilege Skills ---
  if (requiresConfirmation(taskCtx, task.intent, task.tier)) {
    const confirmReq = createConfirmRequest(taskCtx, task);
    await updateTaskStatus(taskCtx, task.taskId, 'input_required', {
      statusMessage: `Awaiting confirmation for ${task.intent} (ID: ${confirmReq.id})`,
    });
    await publishTaskEvent(taskCtx, task.taskId, {
      type: 'status_update',
      data: { status: 'input_required', confirmationId: confirmReq.id },
    });
    await auditLog(taskCtx, { event: 'confirm_requested', taskId: task.taskId, metadata: { confirmId: confirmReq.id, intent: task.intent } });

    const decision = await waitForConfirmation(taskCtx, confirmReq.id);

    if (decision === 'denied') {
      await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'Confirmation denied by operator' });
      await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed', reason: 'HUMAN_DENIED' } });
      await auditLog(taskCtx, { event: 'confirm_denied', taskId: task.taskId });
      return;
    }
    if (decision === 'timeout') {
      await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'Confirmation timed out' });
      await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed', reason: 'CONFIRMATION_TIMEOUT' } });
      await auditLog(taskCtx, { event: 'confirm_timeout', taskId: task.taskId });
      return;
    }

    // Approved — continue to delivery
    await auditLog(taskCtx, { event: 'confirm_approved', taskId: task.taskId });
    await updateTaskStatus(taskCtx, task.taskId, 'working');
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'working' } });
  }

  const operatorUrl = getOperatorUrl(taskCtx);
  if (!operatorUrl) {
    logger.error({ taskCtx }, 'No operator URL configured for agent');
    await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'No operator URL configured' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed' } });
    return;
  }

  const delivery = await deliverToOperator(operatorUrl, task);

  if (!delivery.success || !delivery.taskResult) {
    deliveryOutcomes.inc({ target: 'operator', outcome: (delivery.httpStatus ?? 0) >= 400 && (delivery.httpStatus ?? 0) < 500 ? 'permanent_failure' : 'transient_failure' });
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

  deliveryOutcomes.inc({ target: 'operator', outcome: 'success' });

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
    deliveryOutcomes.inc({ target: 'replyTo', outcome: 'transient_failure' });
    logger.warn({ taskId: task.taskId, error: replyResult.error }, 'replyTo delivery failed');
    await auditLog(taskCtx, {
      event: 'delivery_transient_failure',
      taskId: task.taskId,
      metadata: { url: task.replyTo, error: replyResult.error },
    });
  } else {
    deliveryOutcomes.inc({ target: 'replyTo', outcome: 'success' });
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

// --- Health/Metrics HTTP Server ---
const HEALTH_PORT = process.env.HEALTH_PORT || 3003;
const connectorStartTime = Date.now();
const healthApp = express();

// Redis heartbeat every 30s
const HEARTBEAT_KEY = 'nova:connector:heartbeat';
setInterval(async () => {
  try {
    await redisConnection.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', 60);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to write heartbeat');
  }
}, 30_000);

healthApp.get('/health', (_req, res) => {
  (async () => {
    const checks = {
      redis: await timedCheck(async () => {
        const pong = await redisConnection.ping();
        if (pong !== 'PONG') throw new Error('Redis ping failed');
      }),
      heartbeat: await timedCheck(async () => {
        const ts = await redisConnection.get(HEARTBEAT_KEY);
        if (!ts) return;
        const age = Date.now() - parseInt(ts, 10);
        if (age > 60_000) throw new Error(`Heartbeat stale: ${age}ms`);
      }),
    };
    const status = aggregateHealth(checks);
    const response: HealthResponse = {
      status, service: 'agent-connector',
      uptime: Math.floor((Date.now() - connectorStartTime) / 1000), checks,
    };
    res.status(status === 'down' ? 503 : 200).json(response);
  })().catch(() => res.status(503).json({ status: 'down', service: 'agent-connector' }));
});

healthApp.get('/metrics', (_req, res) => {
  connectorRegistry.metrics().then(metrics => {
    res.set('Content-Type', connectorRegistry.contentType);
    res.end(metrics);
  }).catch(() => res.status(500).end('Error collecting metrics'));
});

healthApp.listen(Number(HEALTH_PORT), () => {
  logger.info(`Agent Connector health/metrics on port ${HEALTH_PORT}`);
});

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down Agent Connector safely...');
  await Promise.all(activeWorkers.map(w => w.close()));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
