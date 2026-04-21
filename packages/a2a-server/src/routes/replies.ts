// packages/a2a-server/src/routes/replies.ts
//
// Broker-mode reply inbox HTTP surface — symmetric to the task inbox at
// /agents/:agentId/inbox. A broker-mode sender (no public webhook) uses these
// endpoints to collect TaskResults delivered by Nova after a recipient agent
// responded to a task the sender issued.
//
//   GET  /agents/:agentId/replies?wait=<ms>          — long-poll pull
//   GET  /agents/:agentId/replies/:taskId            — direct lookup by taskId
//   POST /agents/:agentId/replies/:taskId/ack        — ack a pulled reply
//
// All three routes authenticate with the agent's self-UCAN via authSelfUcan.

import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { BROKER_MAX_WAIT_MS } from '@nova/shared/src/broker-config';
import * as replyInbox from '@nova/task-queue/src/reply-inbox';
import { authSelfUcan } from '../auth/self-ucan';

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
