// packages/agent-connector/src/process-task.ts
//
// The BullMQ worker handler. Pure function of (job, ctx) — no module-level
// side effects, so it can be imported and unit-tested without firing the
// worker pool, audit drain, reclaim loop, or health server.
//
// Lifecycle (per task):
//   1. publish lifecycle 'queued'
//   2. TTL check
//   3. transition working
//   4. confirmation gate (delay-loop via BullMQ moveToDelayed)
//   5. deliver to operator URL (webhook) OR enqueue to broker inbox
//   6. on success, route the TaskResult back via deliverReply
//   7. publish lifecycle 'completed' / 'failed'
//
// processTask is decomposed further in a follow-up PR; this file currently
// hosts the full body to keep PR #2 a pure relocation.

import type { Job } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import type { TenantContext } from '@nova/shared/src/tenant';
import type { QueuedTask } from '@nova/shared/src/types';
import { TASK_LIFECYCLE_CHANNEL, getAgentByDid, TaskLifecycleEvent } from '@nova/shared/src/agent-index';
import { updateTaskStatus, publishTaskEvent, enqueue as inboxEnqueue, isBrokerAgent } from '@nova/task-queue/src/index';
import { writeDeadLetter } from '@nova/task-queue/src/dead-letter';
import { deliverReply } from '@nova/task-queue/src/reply-delivery';
import { getSharedRedis } from '@nova/shared/src/redis';
import { replyMetricOutcome } from './reply-metric';
import { deliverToOperator } from './delivery';
import { getOperatorUrl } from './config';
import { deliveryOutcomes } from './metrics';
import { requiresConfirmation, createConfirmRequest, checkConfirmation, findPendingConfirmByTaskId } from './confirmation';

/** Milliseconds between confirmation re-check cycles. Default: 5 minutes. */
const CONFIRM_RECHECK_DELAY_MS = parseInt(process.env.CONFIRM_RECHECK_DELAY_MS || '300000', 10);

export async function processTask(job: Job, _ctx: TenantContext): Promise<void> {
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
      logger.info({ ctx: taskCtx, taskId: task.taskId, confirmId: existingConfirmId }, 'Recovered stalled confirm job');
      return;
    }
  }
  if (task.confirmId) {
    const status = await checkConfirmation(taskCtx, task.confirmId);

    if (status === 'pending') {
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

    await auditLog(taskCtx, { event: 'confirm_approved', taskId: task.taskId });
    await publishTaskEvent(taskCtx, task.taskId, { type: 'status_update', data: { status: 'working' } });
  }

  if (!task.confirmId && await requiresConfirmation(taskCtx, task.intent, task.tier)) {
    const confirmReq = await createConfirmRequest(taskCtx, task);
    await updateTaskStatus(taskCtx, task.taskId, 'input_required', {
      statusMessage: `Awaiting confirmation for ${task.intent} (ID: ${confirmReq.id})`,
    });
    await publishTaskEvent(taskCtx, task.taskId, {
      type: 'status_update',
      data: { status: 'input_required', confirmationId: confirmReq.id },
    });
    await auditLog(taskCtx, { event: 'confirm_requested', taskId: task.taskId, metadata: { confirmId: confirmReq.id, intent: task.intent } });

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
  // for synchronous responses (PR #79).
  const outcome = await deliverReply(task.taskId, delivery.taskResult, {
    ...(task.replyTo ? { replyTo: task.replyTo } : {}),
    ...(task.senderTenantId ? { senderTenantId: task.senderTenantId } : {}),
    ...(task.senderAgentId ? { senderAgentId: task.senderAgentId } : {}),
    recipientCtx: taskCtx,
  });
  deliveryOutcomes.inc({ target: 'replyTo', outcome: replyMetricOutcome(outcome) });

  await publishLifecycle('completed');
}
