// packages/a2a-server/src/routes/inbox.ts
import IORedis from 'ioredis';
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
import { redis } from '@nova/task-queue/src/index';
import * as inbox from '@nova/task-queue/src/inbox';
import * as replyInbox from '@nova/task-queue/src/reply-inbox';
import { writeDeadLetter } from '@nova/task-queue/src/dead-letter';
import { authSelfUcan } from '../auth/self-ucan';
import { activeSseStreams } from '../metrics';

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

// ── GET /agents/:agentId/inbox/peek — non-destructive snapshot ──────────────

inboxRouter.get('/:agentId/inbox/peek', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramAgentId = req.params['agentId'];
    if (!paramAgentId) return void res.status(400).json({ error: 'AGENT_ID_REQUIRED' });

    const ctx = await authSelfUcan(req, res, paramAgentId);
    if (!ctx) return;

    const entries = await inbox.list(ctx);
    // Project to the public notification shape — no reason to leak reclaimCount
    // or the full QueuedTask here; callers that want to claim + handle should
    // use the pull endpoint.
    const items = entries.map(e => ({
      seq: e.seq ?? null,
      taskId: e.taskId,
      intent: e.task.intent,
      enqueuedAt: e.task.queuedAt ?? null,
    }));
    res.status(200).json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

// ── GET /agents/:agentId/inbox/stream — SSE inbox notifications ─────────────
//
// Resume contract: client may send Last-Event-ID with the seq of the last
// notification it processed. The replay path skips entries whose seq is <=
// that value. Live events are forwarded as they arrive.
//
// Resume-gap handling (see docs/superpowers/specs/2026-04-22-mcp-push-subscriptions.md
// §"The resume gap"): SUBSCRIBE first and buffer live events, then LRANGE
// snapshot, flush snapshot, then flush buffered live events skipping any seq
// already emitted during snapshot.

const INBOX_HEARTBEAT_INTERVAL_MS = 15_000;

function writeSSE(
  res: Response,
  event: { id?: number | undefined; type: string; data: unknown },
): void {
  if (event.id !== undefined) res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  if (typeof (res as any).flush === 'function') (res as any).flush();
}

inboxRouter.get('/:agentId/inbox/stream', async (req: Request, res: Response) => {
  const paramAgentId = req.params['agentId'];
  if (!paramAgentId) return void res.status(400).json({ error: 'AGENT_ID_REQUIRED' });

  const ctx = await authSelfUcan(req, res, paramAgentId);
  if (!ctx) return;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const lastEventId = parseInt((req.headers['last-event-id'] as string) ?? '0', 10) || 0;
  const channel = inbox.inboxNotifyChannel(ctx);

  let cleaned = false;
  let sub: IORedis | null = null;
  activeSseStreams.inc();

  // Seqs emitted during the replay phase. We skip these when flushing the
  // buffered live events (they'd be duplicates) and when forwarding live
  // events (protects against the SUBSCRIBE-before-LRANGE window where the
  // same task was already captured in the snapshot).
  const replayedSeqs = new Set<number>();
  let replayDone = false;
  const buffered: string[] = [];

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    activeSseStreams.dec();
    clearInterval(heartbeat);
    if (sub) {
      sub.unsubscribe().catch(() => {});
      sub.quit().catch(() => {});
      sub = null;
    }
  }

  const heartbeat = setInterval(() => {
    try {
      writeSSE(res, { type: 'heartbeat', data: { at: new Date().toISOString() } });
    } catch {
      cleanup();
    }
  }, INBOX_HEARTBEAT_INTERVAL_MS);

  try {
    sub = redis.duplicate();
    await sub.subscribe(channel);
  } catch (err: any) {
    logger.error({ err: err.message, ctx }, 'Failed to subscribe to inbox notify channel');
    cleanup();
    return void res.end();
  }

  sub.on('message', (_channel, message) => {
    if (!replayDone) {
      buffered.push(message);
      return;
    }
    try {
      const note = JSON.parse(message) as inbox.InboxNotification;
      if (replayedSeqs.has(note.seq)) return;
      if (note.seq <= lastEventId) return;
      writeSSE(res, { id: note.seq, type: 'enqueued', data: note });
    } catch (err: any) {
      logger.warn({ err: err.message, ctx }, 'Malformed inbox-notify message');
    }
  });

  sub.on('error', (err) => {
    logger.error({ err: err.message, ctx }, 'Inbox SSE subscriber error');
    cleanup();
    res.end();
  });

  req.on('close', () => cleanup());

  // Snapshot replay. list() returns newest-first (LPUSH head); emit oldest-
  // first so SSE `id:` values are monotonically increasing, matching what a
  // client expects from a resumable stream.
  try {
    const entries = await inbox.list(ctx);
    entries.reverse();
    for (const entry of entries) {
      if (typeof entry.seq !== 'number') continue;
      if (entry.seq <= lastEventId) continue;
      const note: inbox.InboxNotification = {
        seq: entry.seq,
        taskId: entry.taskId,
        intent: entry.task.intent,
        enqueuedAt: entry.task.queuedAt ?? new Date().toISOString(),
      };
      writeSSE(res, { id: entry.seq, type: 'enqueued', data: note });
      replayedSeqs.add(entry.seq);
    }
  } catch (err: any) {
    logger.warn({ err: err.message, ctx }, 'Inbox SSE replay failed');
  }

  // Flush the live events that arrived during replay. Dedup against the
  // replay set, and honor Last-Event-ID.
  replayDone = true;
  for (const message of buffered) {
    try {
      const note = JSON.parse(message) as inbox.InboxNotification;
      if (replayedSeqs.has(note.seq)) continue;
      if (note.seq <= lastEventId) continue;
      writeSSE(res, { id: note.seq, type: 'enqueued', data: note });
    } catch {
      // tolerated — same as live-path parse failure
    }
  }
  buffered.length = 0;
});
