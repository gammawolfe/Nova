// packages/a2a-server/src/routes/inbox.ts
import express, { Router, Request, Response, NextFunction } from 'express';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import {
  TASK_LIFECYCLE_CHANNEL,
  TaskLifecycleEvent,
} from '@nova/shared/src/agent-index';
import { getSharedRedis } from '@nova/shared/src/redis';
import { TaskResult } from '@nova/shared/src/types';
import {
  BROKER_MAX_WAIT_MS,
  BROKER_RESULT_MAX_BYTES,
} from '@nova/shared/src/broker-config';
import {
  markBrokerPresenceOffline,
  markBrokerPresenceOnline,
  refreshBrokerPresence,
} from '@nova/shared/src/broker-presence';
import * as inbox from '@nova/task-queue/src/inbox';
import { deliverReply } from '@nova/task-queue/src/reply-delivery';
import { authSelfUcan } from '../auth/self-ucan';
import { createSseHandler } from '../sse-handler';

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
//
// H2 — Dedicated express.json with a larger limit, sized to
// BROKER_RESULT_MAX_BYTES. Mounted as the first handler on this route so it
// supersedes the global 64kb parser the rest of the service uses. We don't
// override globally because the larger limit is only needed for TaskResult
// payloads — task ingress and admin POSTs stay tight.
const respondBodyParser = express.json({
  limit: BROKER_RESULT_MAX_BYTES,
});

inboxRouter.post(
  '/:agentId/inbox/:taskId/respond',
  respondBodyParser,
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

      // Route the result back to the sender. All branches (webhook,
      // broker reply inbox, no-target) and their failure-mode handling
      // (DLQ + audit) live in deliverReply so the HTTP layer stays
      // transport-only. Pass the already-serialized body to avoid a
      // second JSON.stringify on the hot path.
      await deliverReply(taskId, taskResult, {
        recipientCtx: ctx,
        ...(entry.task.replyTo ? { replyTo: entry.task.replyTo } : {}),
        ...(entry.task.senderTenantId ? { senderTenantId: entry.task.senderTenantId } : {}),
        ...(entry.task.senderAgentId ? { senderAgentId: entry.task.senderAgentId } : {}),
        serializedResult: serialized,
      });

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
// Resume contract: client sends Last-Event-ID with the seq of the last
// notification it processed; replay skips entries whose seq is <= that
// value. The factory closes the resume gap via subscribe-first-then-replay-
// then-drain-buffered ordering (see sse-handler.ts).

const inboxStreamHandler = createSseHandler({
  logTag: 'inbox-stream',
  channel: (req: Request) => inbox.inboxNotifyChannel(req.ctx),
  onOpen: (req: Request, connectionId: string) => markBrokerPresenceOnline(req.ctx, connectionId),
  onHeartbeat: (req: Request, connectionId: string) => refreshBrokerPresence(req.ctx, connectionId),
  onClose: (req: Request, connectionId: string) => markBrokerPresenceOffline(req.ctx, connectionId),
  async *replay(req) {
    // list() returns newest-first (LPUSH head); emit oldest-first so SSE
    // `id:` values are monotonically increasing, matching what a resumable
    // client expects.
    const entries = await inbox.list(req.ctx);
    entries.reverse();
    for (const entry of entries) {
      if (typeof entry.seq !== 'number') continue;
      const note: inbox.InboxNotification = {
        seq: entry.seq,
        taskId: entry.taskId,
        intent: entry.task.intent,
        enqueuedAt: entry.task.queuedAt ?? new Date().toISOString(),
      };
      yield { id: entry.seq, type: 'enqueued', data: note };
    }
  },
  parseLive(raw) {
    try {
      const note = JSON.parse(raw) as inbox.InboxNotification;
      return { id: note.seq, type: 'enqueued', data: note };
    } catch {
      return null;
    }
  },
});

inboxRouter.get('/:agentId/inbox/stream', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramAgentId = req.params['agentId'];
    if (!paramAgentId) return void res.status(400).json({ error: 'AGENT_ID_REQUIRED' });
    const ctx = await authSelfUcan(req, res, paramAgentId);
    if (!ctx) return;
    req.ctx = ctx;
    await inboxStreamHandler(req, res);
  } catch (err) {
    next(err);
  }
});
