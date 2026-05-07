// packages/a2a-server/src/routes/replies.ts
//
// Broker-mode reply inbox HTTP surface — symmetric to the task inbox at
// /agents/:agentId/inbox. A broker-mode sender (no public webhook) uses these
// endpoints to collect TaskResults delivered by Nova after a recipient agent
// responded to a task the sender issued.
//
//   GET  /agents/:agentId/replies?wait=<ms>          — long-poll pull
//   GET  /agents/:agentId/replies/peek               — non-destructive snapshot
//   GET  /agents/:agentId/replies/stream             — SSE notifications
//   GET  /agents/:agentId/replies/:taskId            — direct lookup by taskId
//   POST /agents/:agentId/replies/:taskId/ack        — ack a pulled reply
//
// All routes authenticate with the agent's self-UCAN via authSelfUcan.
// Route-registration order matters: the specific `/peek` and `/stream`
// handlers must be declared before `/:taskId` so Express matches them
// exactly instead of interpreting the path as a taskId parameter.

import IORedis from 'ioredis';
import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { BROKER_MAX_WAIT_MS } from '@nova/shared/src/broker-config';
import { redis } from '@nova/task-queue/src/index';
import * as replyInbox from '@nova/task-queue/src/reply-inbox';
import { authSelfUcan } from '../auth/self-ucan';
import { activeSseStreams } from '../metrics';
import { registerSseCleanup } from '../sse-registry';

export const repliesRouter = Router({ mergeParams: true });

// ── GET /agents/:agentId/replies?wait=<ms> — long-poll pull ──────────────────

repliesRouter.get('/:agentId/replies', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramAgentId = req.params['agentId'];
    if (!paramAgentId) return void res.status(400).json({ error: 'AGENT_ID_REQUIRED' });

    const ctx = await authSelfUcan(req, res, paramAgentId);
    if (!ctx) return;

    let wait = parseInt(String(req.query['wait'] ?? '30000'), 10);
    if (!Number.isFinite(wait) || wait < 0) wait = 30000;
    wait = Math.min(wait, BROKER_MAX_WAIT_MS);

    const popped = await replyInbox.pullReply(ctx, wait);
    if (!popped) return void res.status(204).send();

    res.status(200).json({
      taskId: popped.taskId,
      result: popped.result,
      visibleUntil: popped.visibleUntil.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /agents/:agentId/replies/peek — non-destructive snapshot ────────────

repliesRouter.get('/:agentId/replies/peek', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramAgentId = req.params['agentId'];
    if (!paramAgentId) return void res.status(400).json({ error: 'AGENT_ID_REQUIRED' });

    const ctx = await authSelfUcan(req, res, paramAgentId);
    if (!ctx) return;

    const entries = await replyInbox.listReplies(ctx);
    const items = entries.map(e => ({
      seq: e.seq ?? null,
      taskId: e.taskId,
      enqueuedAt: e.result.completedAt ?? null,
    }));
    res.status(200).json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

// ── GET /agents/:agentId/replies/stream — SSE notifications ─────────────────
//
// Subscribe-first-then-snapshot pattern with seq-based dedup, identical to
// the inbox stream. Last-Event-ID resume skips already-delivered
// notifications. See docs/superpowers/specs/2026-04-22-mcp-push-subscriptions.md
// §"The resume gap".

const REPLY_HEARTBEAT_INTERVAL_MS = 15_000;

function writeSSE(
  res: Response,
  event: { id?: number | undefined; type: string; data: unknown },
): void {
  if (event.id !== undefined) res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  if (typeof (res as any).flush === 'function') (res as any).flush();
}

repliesRouter.get('/:agentId/replies/stream', async (req: Request, res: Response) => {
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
  const channel = replyInbox.replyInboxNotifyChannel(ctx);

  let cleaned = false;
  let sub: IORedis | null = null;
  activeSseStreams.inc();

  const replayedSeqs = new Set<number>();
  let replayDone = false;
  const buffered: string[] = [];

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    activeSseStreams.dec();
    clearInterval(heartbeat);
    unregister();
    if (sub) {
      sub.unsubscribe().catch(() => {});
      sub.quit().catch(() => {});
      sub = null;
    }
  }

  // H1 — register cleanup with the global SSE registry so graceful shutdown
  // tears down reply subscribers along with task-stream + inbox subscribers.
  const unregister = registerSseCleanup(cleanup);

  const heartbeat = setInterval(() => {
    try {
      writeSSE(res, { type: 'heartbeat', data: { at: new Date().toISOString() } });
    } catch {
      cleanup();
    }
  }, REPLY_HEARTBEAT_INTERVAL_MS);

  try {
    sub = redis.duplicate();
    await sub.subscribe(channel);
  } catch (err: any) {
    logger.error({ err: err.message, ctx }, 'Failed to subscribe to reply-inbox notify channel');
    cleanup();
    return void res.end();
  }

  sub.on('message', (_channel, message) => {
    if (!replayDone) {
      buffered.push(message);
      return;
    }
    try {
      const note = JSON.parse(message) as replyInbox.ReplyInboxNotification;
      if (replayedSeqs.has(note.seq)) return;
      if (note.seq <= lastEventId) return;
      writeSSE(res, { id: note.seq, type: 'enqueued', data: note });
    } catch (err: any) {
      logger.warn({ err: err.message, ctx }, 'Malformed reply-inbox-notify message');
    }
  });

  sub.on('error', (err) => {
    logger.error({ err: err.message, ctx }, 'Reply SSE subscriber error');
    cleanup();
    res.end();
  });

  req.on('close', () => cleanup());

  // Snapshot replay. listReplies returns newest-first (LPUSH head); emit
  // oldest-first so SSE id values are monotonically increasing.
  try {
    const entries = await replyInbox.listReplies(ctx);
    entries.reverse();
    for (const entry of entries) {
      if (typeof entry.seq !== 'number') continue;
      if (entry.seq <= lastEventId) continue;
      const note: replyInbox.ReplyInboxNotification = {
        seq: entry.seq,
        taskId: entry.taskId,
        enqueuedAt: entry.result.completedAt ?? new Date().toISOString(),
      };
      writeSSE(res, { id: entry.seq, type: 'enqueued', data: note });
      replayedSeqs.add(entry.seq);
    }
  } catch (err: any) {
    logger.warn({ err: err.message, ctx }, 'Reply SSE replay failed');
  }

  replayDone = true;
  for (const message of buffered) {
    try {
      const note = JSON.parse(message) as replyInbox.ReplyInboxNotification;
      if (replayedSeqs.has(note.seq)) continue;
      if (note.seq <= lastEventId) continue;
      writeSSE(res, { id: note.seq, type: 'enqueued', data: note });
    } catch {
      // tolerated — same as live-path parse failure
    }
  }
  buffered.length = 0;
});

// ── GET /agents/:agentId/replies/:taskId — direct lookup by taskId ───────────

repliesRouter.get('/:agentId/replies/:taskId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramAgentId = req.params['agentId'];
    const taskId = req.params['taskId'];
    if (!paramAgentId || !taskId) {
      return void res.status(400).json({ error: 'MISSING_PARAMS' });
    }

    const ctx = await authSelfUcan(req, res, paramAgentId);
    if (!ctx) return;

    const stored = await replyInbox.getStoredResult(ctx, taskId);
    if (!stored) return void res.status(404).json({ status: 'not_found' });

    res.status(200).json({ result: stored });
  } catch (err) {
    next(err);
  }
});

// ── POST /agents/:agentId/replies/:taskId/ack — ack a pulled reply ───────────

repliesRouter.post('/:agentId/replies/:taskId/ack', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramAgentId = req.params['agentId'];
    const taskId = req.params['taskId'];
    if (!paramAgentId || !taskId) {
      return void res.status(400).json({ error: 'MISSING_PARAMS' });
    }

    const ctx = await authSelfUcan(req, res, paramAgentId);
    if (!ctx) return;

    const outcome = await replyInbox.ackReply(ctx, taskId);
    if (outcome === 'reply_not_found') {
      return void res.status(404).json({ status: 'reply_not_found' });
    }
    if (outcome === 'already_acked') {
      return void res.status(409).json({ status: 'already_acked' });
    }

    await auditLog(ctx, { event: 'reply_acked', taskId });
    logger.info({ taskId, agentId: ctx.agentId }, 'Reply acked');

    res.status(202).json({ status: 'accepted' });
  } catch (err) {
    next(err);
  }
});
