import express from 'express';
import { Job } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { auditLog, startAuditLogConsumer } from '@nova/shared/src/audit';
import { TenantContext, DATA_ROOT } from '@nova/shared/src/tenant';
import { QueuedTask } from '@nova/shared/src/types';
import { TASK_LIFECYCLE_CHANNEL, getAgentByDid, TaskLifecycleEvent } from '@nova/shared/src/agent-index';
import { updateTaskStatus, publishTaskEvent, enqueue as inboxEnqueue, isBrokerAgent, reclaimAll, recoverOrphansAll } from '@nova/task-queue/src/index';
import { writeDeadLetter } from '@nova/task-queue/src/dead-letter';
import * as replyInbox from '@nova/task-queue/src/reply-inbox';
import { deliverReply } from '@nova/task-queue/src/reply-delivery';
import { replyMetricOutcome } from './reply-metric';
import { BROKER_RECLAIM_INTERVAL_MS } from '@nova/shared/src/broker-config';
import { timedCheck, healthHandler } from '@nova/shared/src/health';
import { metricsHandler } from '@nova/shared/src/metrics';
import { getSharedRedis } from '@nova/shared/src/redis';
import { deliverToOperator } from './delivery';
import { getOperatorUrl } from './config';
import { connectorRegistry, deliveryOutcomes } from './metrics';
import { requiresConfirmation, createConfirmRequest, checkConfirmation, findPendingConfirmByTaskId } from './confirmation';
import { initWorkerManager, shutdownAllWorkers } from './worker-manager';

export const redisConnection = getSharedRedis();

/** Milliseconds between confirmation re-check cycles. Default: 5 minutes. */
const CONFIRM_RECHECK_DELAY_MS = parseInt(process.env.CONFIRM_RECHECK_DELAY_MS || '300000', 10);

async function processTask(job: Job, ctx: TenantContext): Promise<void> {
  const task = job.data as QueuedTask;
  const taskCtx: TenantContext = { tenantId: task.tenantId, agentId: task.agentId };

  logger.info({ jobId: job.id, taskId: task.taskId, intent: task.intent }, 'Processing task');

  // Resolve source agent for lifecycle events — may be null for unknown senders
  const sourceAgent = await getAgentByDid(getSharedRedis(), task.senderDid);
  const lifecycleBase: Omit<TaskLifecycleEvent, 'action'> = {
    taskId: task.taskId,
    toTenantId: task.tenantId,
    toAgentId: task.agentId,
    ...(sourceAgent ? { fromTenantId: sourceAgent.tenantId, fromAgentId: sourceAgent.agentId } : {}),
  };

  const publishLifecycle = async (action: TaskLifecycleEvent['action']) => {
    try {
      await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify({
        action, ...lifecycleBase,
      } satisfies TaskLifecycleEvent));
    } catch (err: any) {
      logger.warn({ err: err.message, taskId: task.taskId, action }, 'Failed to publish lifecycle event');
    }
  };

  await publishLifecycle('queued');

  // Check TTL first
  if (new Date(task.expiresAt) <= new Date()) {
    await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'Task TTL expired before processing' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed', reason: 'TTL_EXPIRED' } });
    await auditLog(taskCtx, { event: 'task_expired', taskId: task.taskId });
    await publishLifecycle('failed');
    return;
  }

  // Task already passed all 5 gate layers (including LLM classification) before entering the queue.
  await updateTaskStatus(taskCtx, task.taskId, 'working');
  await publishTaskEvent(taskCtx, task.taskId, {
    type: 'status_update',
    data: { status: 'working' },
  });
  await auditLog(taskCtx, { event: 'task_started', taskId: task.taskId, tier: task.tier });

  // --- Confirmation Gate: non-blocking via BullMQ delayed re-queue ---
  // Crash recovery: if a stalled job is re-queued, it may have a pending confirm
  // file on disk even though confirmId was never persisted to the job data.
  if (!task.confirmId && await requiresConfirmation(taskCtx, task.intent, task.tier)) {
    const existingConfirmId = await findPendingConfirmByTaskId(taskCtx, task.taskId);
    if (existingConfirmId) {
      await job.updateData({
        ...job.data,
        confirmId: existingConfirmId,
      });
      const nextCheck = Date.now() + CONFIRM_RECHECK_DELAY_MS;
      await job.moveToDelayed(nextCheck);
      logger.info({ ctx: taskCtx, taskId: task.taskId, confirmId: existingConfirmId }, 'Recovered stalled confirm job') ;
      return;
    }
  }
  if (task.confirmId) {
    // Re-queued job: check current confirmation status (non-blocking)
    const status = await checkConfirmation(taskCtx, task.confirmId);

    if (status === 'pending') {
      // Still waiting — re-delay for another cycle
      const nextCheck = Date.now() + CONFIRM_RECHECK_DELAY_MS;
      await updateTaskStatus(taskCtx, task.taskId, 'input_required', {
        statusMessage: `Awaiting confirmation for ${task.intent}`,
      });
      await job.moveToDelayed(nextCheck);
      return;
    }

    if (status === 'denied') {
      await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'Confirmation denied by operator' });
      await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed', reason: 'HUMAN_DENIED' } });
      await auditLog(taskCtx, { event: 'confirm_denied', taskId: task.taskId });
      await publishLifecycle('failed');
      return;
    }

    if (status === 'timeout') {
      await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'Confirmation timed out' });
      await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed', reason: 'CONFIRMATION_TIMEOUT' } });
      await auditLog(taskCtx, { event: 'confirm_timeout', taskId: task.taskId });
      await publishLifecycle('failed');
      return;
    }

    // Approved — continue to delivery
    await auditLog(taskCtx, { event: 'confirm_approved', taskId: task.taskId });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'working' } });
  }

  if (!task.confirmId && await requiresConfirmation(taskCtx, task.intent, task.tier)) {
    // First encounter: create confirmation request and move job to delayed
    const confirmReq = await createConfirmRequest(taskCtx, task);
    await updateTaskStatus(taskCtx, task.taskId, 'input_required', {
      statusMessage: `Awaiting confirmation for ${task.intent} (ID: ${confirmReq.id})`,
    });
    await publishTaskEvent(taskCtx, task.taskId, {
      type: 'status_update',
      data: { status: 'input_required', confirmationId: confirmReq.id },
    });
    await auditLog(taskCtx, { event: 'confirm_requested', taskId: task.taskId, metadata: { confirmId: confirmReq.id, intent: task.intent } });

    // Update job data with confirmId and delay
    const nextCheck = Date.now() + CONFIRM_RECHECK_DELAY_MS;
    await job.updateData({
      ...job.data,
      confirmId: confirmReq.id,
      confirmRequestAt: new Date().toISOString(),
    });
    await job.moveToDelayed(nextCheck);
    return;
  }

  const operatorUrl = await getOperatorUrl(taskCtx);
  if (!operatorUrl) {
    // Broker path — agent receives via MCP pull, not HTTP webhook
    if (await isBrokerAgent(taskCtx)) {
      await inboxEnqueue(taskCtx, task);
      await updateTaskStatus(taskCtx, task.taskId, 'queued', { statusMessage: 'Queued in agent inbox (broker mode)' });
      await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'queued' } });
      await auditLog(taskCtx, { event: 'task_broker_queued', taskId: task.taskId });
      await publishLifecycle('queued');
      logger.info({ taskCtx, taskId: task.taskId }, 'Task enqueued to broker inbox');
      return;
    }

    logger.error({ taskCtx }, 'No operator URL configured and agent is not in broker mode');
    await updateTaskStatus(taskCtx, task.taskId, 'failed', { statusMessage: 'No operator URL configured' });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'failed' } });
    await publishLifecycle('failed');
    return;
  }

  const delivery = await deliverToOperator(operatorUrl, task);

  if (!delivery.success || !delivery.taskResult) {
    deliveryOutcomes.inc({ target: 'operator', outcome: (delivery.httpStatus ?? 0) >= 400 && (delivery.httpStatus ?? 0) < 500 ? 'permanent_failure' : 'transient_failure' });
    const httpStatus = delivery.httpStatus ?? 0;

    // Write to dead letter for 4xx errors
    if (httpStatus >= 400 && httpStatus < 500) {
      const deadLetterId = await writeDeadLetter(taskCtx, {
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
    await publishLifecycle('failed');
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

  // Route the recipient's TaskResult back to the original sender. The matrix
  // (replyTo webhook / sender broker inbox / no target) and its failure-mode
  // DLQ handling are owned by deliverReply — same call shape a2a-server uses
  // for synchronous responses (PR #79). Outcome → metric mapping below.
  const outcome = await deliverReply(task.taskId, delivery.taskResult, {
    ...(task.replyTo ? { replyTo: task.replyTo } : {}),
    ...(task.senderTenantId ? { senderTenantId: task.senderTenantId } : {}),
    ...(task.senderAgentId ? { senderAgentId: task.senderAgentId } : {}),
    recipientCtx: taskCtx,
  });
  deliveryOutcomes.inc({ target: 'replyTo', outcome: replyMetricOutcome(outcome) });

  await publishLifecycle('completed');
}

initWorkerManager(processTask).catch(err => {
  logger.error({ err }, 'Worker manager failed to boot');
  process.exit(1);
});

// ── Audit drain consumer ───────────────────────────────────────────────────
//
// This process is the canonical host for the audit drain: it's the only
// long-running service that doesn't sit on the HTTP request path. The
// consumer reads from `nova:audit:stream` (XADD'd by every service via
// auditLog) and writes per-tenant daily JSONL files under DATA_ROOT/audit/.
// admin-api's queryAuditLogs reads those files; without this consumer
// running, the audit stream accumulates in Redis forever and admin queries
// return empty.
//
// The abort controller is wired into the shutdown sequence below so the
// consumer exits cleanly on SIGTERM rather than getting terminated
// mid-XREADGROUP.
const auditDrainAbort = new AbortController();
startAuditLogConsumer(DATA_ROOT, { signal: auditDrainAbort.signal })
  .catch(err => logger.error({ err }, 'Audit drain consumer crashed'));

// ── Broker inbox reclaim worker ─────────────────────────────────────────────
let reclaimTimer: NodeJS.Timeout | null = null;

async function reclaimTick(): Promise<void> {
  try {
    // Two concerns, same cadence:
    //  - reclaimAll: redeliver in-flight entries whose visibility
    //    timeout expired (recipient stopped responding mid-task).
    //  - recoverOrphansAll: redeliver entries left in per-process
    //    holding lists by processes whose heartbeat has expired
    //    (the pull side crashed between BLMOVE and the claim MULTI).
    const [taskSweep, replySweep, taskOrphans, replyOrphans] = await Promise.all([
      reclaimAll(),
      replyInbox.reclaimAllReplies(),
      recoverOrphansAll(),
      replyInbox.recoverOrphansAllReplies(),
    ]);
    if (taskSweep.redelivered > 0 || taskSweep.deadLettered > 0) {
      logger.info(
        { redelivered: taskSweep.redelivered, deadLettered: taskSweep.deadLettered },
        'Broker task reclaim tick',
      );
    }
    if (replySweep.redelivered > 0 || replySweep.deadLettered > 0) {
      logger.info(
        { redelivered: replySweep.redelivered, deadLettered: replySweep.deadLettered },
        'Broker reply reclaim tick',
      );
    }
    if (taskOrphans.recovered > 0 || taskOrphans.dropped > 0) {
      logger.info(
        { recovered: taskOrphans.recovered, dropped: taskOrphans.dropped },
        'Broker task orphan sweep',
      );
    }
    if (replyOrphans.recovered > 0 || replyOrphans.dropped > 0) {
      logger.info(
        { recovered: replyOrphans.recovered, dropped: replyOrphans.dropped },
        'Broker reply orphan sweep',
      );
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Broker reclaim tick failed');
  }
}

function startReclaimWorker(): void {
  if (reclaimTimer) return;
  reclaimTimer = setInterval(reclaimTick, BROKER_RECLAIM_INTERVAL_MS);
  logger.info({ intervalMs: BROKER_RECLAIM_INTERVAL_MS }, 'Broker reclaim worker started');
}

function stopReclaimWorker(): void {
  if (reclaimTimer) {
    clearInterval(reclaimTimer);
    reclaimTimer = null;
  }
}

startReclaimWorker();

// --- Health/Metrics HTTP Server ---
const HEALTH_PORT = process.env.HEALTH_PORT || 3003;
const connectorStartTime = Date.now();
const healthApp = express();

// Redis heartbeat every 30s
const HEARTBEAT_KEY = 'nova:connector:heartbeat';
const heartbeatInterval = setInterval(async () => {
  try {
    await redisConnection.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', 60);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to write heartbeat');
  }
}, 30_000);

healthApp.get('/health', (healthHandler('agent-connector', connectorStartTime, async () => {
  const [redis, heartbeat] = await Promise.all([
    timedCheck(async () => {
      const pong = await redisConnection.ping();
      if (pong !== 'PONG') throw new Error('Redis ping failed');
    }),
    timedCheck(async () => {
      const ts = await redisConnection.get(HEARTBEAT_KEY);
      if (!ts) return;
      const age = Date.now() - parseInt(ts, 10);
      if (age > 60_000) throw new Error(`Heartbeat stale: ${age}ms`);
    }),
  ]);
  return { redis, heartbeat };
})) as any);

healthApp.get('/metrics', metricsHandler(connectorRegistry));

const healthServer = healthApp.listen(Number(HEALTH_PORT), () => {
  logger.info(`Agent Connector health/metrics on port ${HEALTH_PORT}`);
});

// Graceful shutdown — watchdog forces exit if any step hangs; idempotent
// so repeated signals are no-ops; closes the health HTTP server too.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.NOVA_SHUTDOWN_TIMEOUT_MS ?? '15000', 10);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'agent-connector shutting down');

  const watchdog = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'agent-connector shutdown watchdog fired — exiting hard');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  try {
    stopReclaimWorker();
    clearInterval(heartbeatInterval);
    // Signal the audit drain consumer to exit cleanly. Its loop blocks on
    // XREADGROUP for up to 5s, so the wait below is bounded.
    auditDrainAbort.abort();
    await shutdownAllWorkers();
    await new Promise<void>((resolve) => {
      healthServer.close((err) => {
        if (err) logger.warn({ err }, 'healthServer.close reported an error');
        resolve();
      });
    });
    logger.info('agent-connector shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown sequence');
  } finally {
    clearTimeout(watchdog);
    process.exit(0);
  }
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
