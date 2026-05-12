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

import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { BROKER_MAX_WAIT_MS } from '@nova/shared/src/broker-config';
import * as replyInbox from '@nova/task-queue/src/reply-inbox';
import { authSelfUcan } from '../auth/self-ucan';
import { createSseHandler } from '../sse-handler';

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
// Symmetric to inbox/stream — same factory, different channel + replay
// source. See sse-handler.ts for the resume-gap pattern (subscribe first,
// replay, drain buffered).

const repliesStreamHandler = createSseHandler({
  logTag: 'reply-stream',
  channel: (req: Request) => replyInbox.replyInboxNotifyChannel(req.ctx),
  async *replay(req) {
    const entries = await replyInbox.listReplies(req.ctx);
    entries.reverse();
    for (const entry of entries) {
      if (typeof entry.seq !== 'number') continue;
      const note: replyInbox.ReplyInboxNotification = {
        seq: entry.seq,
        taskId: entry.taskId,
        enqueuedAt: entry.result.completedAt ?? new Date().toISOString(),
      };
      yield { id: entry.seq, type: 'enqueued', data: note };
    }
  },
  parseLive(raw) {
    try {
      const note = JSON.parse(raw) as replyInbox.ReplyInboxNotification;
      return { id: note.seq, type: 'enqueued', data: note };
    } catch {
      return null;
    }
  },
});

repliesRouter.get('/:agentId/replies/stream', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramAgentId = req.params['agentId'];
    if (!paramAgentId) return void res.status(400).json({ error: 'AGENT_ID_REQUIRED' });
    const ctx = await authSelfUcan(req, res, paramAgentId);
    if (!ctx) return;
    req.ctx = ctx;
    await repliesStreamHandler(req, res);
  } catch (err) {
    next(err);
  }
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
