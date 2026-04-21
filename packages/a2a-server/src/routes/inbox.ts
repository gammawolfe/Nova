// packages/a2a-server/src/routes/inbox.ts
import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import {
  TASK_LIFECYCLE_CHANNEL,
  TaskLifecycleEvent,
  getAgentMeta,
} from '@nova/shared/src/agent-index';
import { getSharedRedis } from '@nova/shared/src/redis';
import { TaskResult } from '@nova/shared/src/types';
import {
  BROKER_MAX_WAIT_MS,
  BROKER_RESULT_MAX_BYTES,
} from '@nova/shared/src/broker-config';
import * as inbox from '@nova/task-queue/src/inbox';
import * as replyInbox from '@nova/task-queue/src/reply-inbox';
import { writeDeadLetter } from '@nova/task-queue/src/dead-letter';
import { authSelfUcan } from '../auth/self-ucan';

// ── Router ───────────────────────────────────────────────────────────────────

export const inboxRouter = Router({ mergeParams: true });

// ── GET /agents/:agentId/inbox?wait=<ms> — long-poll pull ───────────────────

inboxRouter.get('/:agentId/inbox', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramAgentId = req.params['agentId'];
    if (!paramAgentId) return void res.status(400).json({ error: 'AGENT_ID_REQUIRED' });

    const ctx = await authSelfUcan(req, res, paramAgentId);
    if (!ctx) return;

    let wait = parseInt(String(req.query['wait'] ?? '30000'), 10);
    if (!Number.isFinite(wait) || wait < 0) wait = 30000;
    wait = Math.min(wait, BROKER_MAX_WAIT_MS);

    const result = await inbox.pull(ctx, wait);
    if (!result) return void res.status(204).send();

    res.status(200).json({
      task: result.task,
      visibleUntil: result.visibleUntil.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /agents/:agentId/inbox/:taskId/respond ─────────────────────────────

inboxRouter.post(
  '/:agentId/inbox/:taskId/respond',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramAgentId = req.params['agentId'];
      const taskId = req.params['taskId'];
      if (!paramAgentId || !taskId) {
        return void res.status(400).json({ error: 'MISSING_PARAMS' });
      }

      const ctx = await authSelfUcan(req, res, paramAgentId);
      if (!ctx) return;

      const { status, result, error } = req.body as {
        status: 'ok' | 'error';
        result?: unknown;
        error?: { code: string; message: string; retryable?: boolean };
      };
      if (status !== 'ok' && status !== 'error') {
        return void res
          .status(400)
          .json({ error: 'INVALID_STATUS', hint: 'Must be "ok" or "error"' });
      }

      const entry = await inbox.peekInflight(ctx, taskId);
      if (!entry) return void res.status(404).json({ status: 'task_not_found' });

      const now = new Date().toISOString();
      const taskResult: TaskResult =
        status === 'ok'
          ? {
              type: 'TaskResult',
              requestId: taskId,
              status: 'ok',
              result: (result as Record<string, unknown>) ?? {},
              auditToken: 'none',
              completedAt: now,
              schemaVersion: '1.0',
            }
          : {
              type: 'TaskResult',
              requestId: taskId,
              status: 'error',
              error: {
                code: error?.code ?? 'BROKER_ERROR',
                message: error?.message ?? 'Receiver reported an error',
                retryable: error?.retryable ?? false,
              },
              auditToken: 'none',
              completedAt: now,
              schemaVersion: '1.0',
            };

      // Size cap — enforce before ZREM so an oversized result can be retried
      // with a trimmed payload without losing the in-flight claim.
      const serialized = JSON.stringify(taskResult);
      const byteLength = Buffer.byteLength(serialized, 'utf8');
      if (byteLength > BROKER_RESULT_MAX_BYTES) {
        return void res.status(413).json({
          error: 'RESULT_TOO_LARGE',
          message: `TaskResult payload is ${byteLength} bytes; maximum is ${BROKER_RESULT_MAX_BYTES}`,
          maxBytes: BROKER_RESULT_MAX_BYTES,
        });
      }

      const outcome = await inbox.respond(ctx, taskId);
      if (outcome === 'task_not_found') {
        return void res.status(404).json({ status: 'task_not_found' });
      }
      if (outcome === 'already_completed') {
        return void res.status(409).json({ status: 'already_completed' });
      }

      // Reply delivery branches on replyTo presence:
      //   1. replyTo URL set       → POST to URL (existing webhook behavior)
      //   2. senderAgentId known   → enqueue to sender's broker reply inbox
      //   3. neither               → log + lifecycle only (ingress should have
      //                              rejected this case, so it's a bug if hit)
      if (entry.task.replyTo) {
        try {
          await fetch(entry.task.replyTo, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: serialized,
            signal: AbortSignal.timeout(10_000),
          });
          await auditLog(ctx, { event: 'reply_delivered', taskId, metadata: { target: 'webhook' } });
        } catch (deliveryErr: any) {
          logger.warn(
            { err: deliveryErr.message, taskId, replyTo: entry.task.replyTo },
            'Broker respond: delivery to replyUrl failed',
          );
        }
      } else if (entry.task.senderTenantId && entry.task.senderAgentId) {
        const senderCtx = {
          tenantId: entry.task.senderTenantId,
          agentId: entry.task.senderAgentId,
        };
        const senderMeta = await getAgentMeta(getSharedRedis(), senderCtx.agentId);
        if (!senderMeta || senderMeta.status !== 'active') {
          // Sender deregistered or suspended between send and respond —
          // result is undeliverable. Persist to DLQ for operator review.
          await writeDeadLetter(senderCtx, {
            taskId,
            targetUrl: 'broker-reply',
            taskResult,
            failureReason: 'reply_sender_inactive',
            httpStatus: 0,
            attemptCount: 1,
          });
          await auditLog(ctx, {
            event: 'reply_sender_inactive',
            taskId,
            metadata: {
              senderTenantId: senderCtx.tenantId,
              senderAgentId: senderCtx.agentId,
              senderStatus: senderMeta?.status ?? 'missing',
            },
          });
          logger.warn(
            { taskId, senderAgentId: senderCtx.agentId, senderStatus: senderMeta?.status ?? 'missing' },
            'Broker respond: sender inactive; result written to dead-letter',
          );
        } else {
          try {
            await replyInbox.enqueueReply(senderCtx, taskId, taskResult);
            await auditLog(ctx, {
              event: 'reply_broker_queued',
              taskId,
              metadata: {
                senderTenantId: senderCtx.tenantId,
                senderAgentId: senderCtx.agentId,
              },
            });
          } catch (enqErr: any) {
            logger.error(
              { err: enqErr.message, taskId, senderAgentId: senderCtx.agentId },
              'Broker respond: reply-inbox enqueue failed',
            );
          }
        }
      } else {
        logger.warn(
          { taskId },
          'Broker respond: neither replyTo nor senderAgentId present — ingress should have rejected this',
        );
      }

      const lifecycle: TaskLifecycleEvent = {
        action: status === 'ok' ? 'completed' : 'failed',
        taskId,
        toTenantId: entry.task.tenantId,
        toAgentId: entry.task.agentId,
      };
      try {
        await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify(lifecycle));
      } catch (pubErr: any) {
        logger.warn(
          { err: pubErr.message, taskId },
          'Broker respond: failed to publish lifecycle event',
        );
      }

      await auditLog(ctx, {
        event: status === 'ok' ? 'task_completed' : 'task_failed',
        taskId,
        metadata: { mode: 'broker' },
      });

      res.status(202).json({ status: 'accepted' });
    } catch (err) {
      next(err);
    }
  },
);
