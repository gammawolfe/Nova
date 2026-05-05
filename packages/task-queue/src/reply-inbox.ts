// packages/task-queue/src/reply-inbox.ts
//
// Broker-mode reply inbox — symmetric to inbox.ts but in the opposite direction.
// When a broker-mode sender omits `replyTo`, the recipient's respond handler
// enqueues the TaskResult onto the sender's reply-inbox instead of POSTing to
// a webhook. The sender then pulls with nova_next_reply (long-poll, at-least-
// once with visibility timeout) and acks via nova_ack_reply. A separate
// direct-lookup key stores the TaskResult by taskId for nova_get_task_result.

import { redis } from './index';
import { TenantContext } from '@nova/shared';
import { TaskResult } from '@nova/shared';
import { logger } from '@nova/shared';
import {
  BROKER_VISIBILITY_TIMEOUT_MS,
  BROKER_RECLAIM_CEILING,
  BROKER_REPLY_RESULT_TTL_SECONDS,
} from '@nova/shared';
import { writeDeadLetter } from './dead-letter';

// ── Key helpers ─────────────────────────────────────────────────────────────

export function replyInboxKey(ctx: TenantContext): string {
  return `nova:reply-inbox:${ctx.tenantId}:${ctx.agentId}`;
}

export function replyInflightKey(ctx: TenantContext): string {
  return `nova:reply-inflight:${ctx.tenantId}:${ctx.agentId}`;
}

export function taskResultKey(ctx: TenantContext, taskId: string): string {
  return `nova:task-result:${ctx.tenantId}:${ctx.agentId}:${taskId}`;
}

export function replyInboxNotifyChannel(ctx: TenantContext): string {
  return `nova:reply-inbox-notify:${ctx.tenantId}:${ctx.agentId}`;
}

export function replyInboxSeqKey(ctx: TenantContext): string {
  return `nova:reply-inbox-seq:${ctx.tenantId}:${ctx.agentId}`;
}

/** Set of "tenantId:agentId" pairs that have at least one pending reply. */
export const BROKER_REPLY_AGENTS_SET = 'nova:broker-reply-agents';

// Matches the inbox-seq + task-events TTL. The seq counter must not outlive
// the reply data it numbers.
const REPLY_INBOX_SEQ_TTL_SECONDS = 60 * 60 * 24;

function memberKey(ctx: TenantContext): string {
  return `${ctx.tenantId}:${ctx.agentId}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ReplyInflightEntry {
  taskId: string;
  result: TaskResult;
  reclaimCount: number;
  // Monotonic per-(tenant,agent) sequence assigned at enqueue. Used as the
  // SSE `id:` value so resuming subscribers can skip already-delivered
  // notifications via Last-Event-ID. Absent on entries enqueued by
  // pre-push builds; consumers tolerate `undefined`.
  seq?: number;
}

export interface ReplyInboxNotification {
  seq: number;
  taskId: string;
  enqueuedAt: string;
}

/**
 * Enqueue a TaskResult to the sender's reply inbox AND persist it by taskId
 * for direct lookup. Both writes share the same pipeline so they either both
 * succeed or both fail together.
 *
 * The stored-result key lives out its TTL independently of inbox consumption —
 * ack only clears the inbox/in-flight state; the direct-lookup key remains
 * retrievable until TTL expiry so nova_get_task_result keeps working.
 */
export async function enqueueReply(
  senderCtx: TenantContext,
  taskId: string,
  result: TaskResult,
): Promise<void> {
  const seq = await redis.incr(replyInboxSeqKey(senderCtx));
  const entry: ReplyInflightEntry = { taskId, result, reclaimCount: 0, seq };
  const notification: ReplyInboxNotification = {
    seq,
    taskId,
    enqueuedAt: new Date().toISOString(),
  };
  await redis.pipeline()
    .expire(replyInboxSeqKey(senderCtx), REPLY_INBOX_SEQ_TTL_SECONDS)
    .lpush(replyInboxKey(senderCtx), JSON.stringify(entry))
    .setex(taskResultKey(senderCtx, taskId), BROKER_REPLY_RESULT_TTL_SECONDS, JSON.stringify(result))
    .sadd(BROKER_REPLY_AGENTS_SET, memberKey(senderCtx))
    .publish(replyInboxNotifyChannel(senderCtx), JSON.stringify(notification))
    .exec();
}

/**
 * Long-poll pull. Blocks up to `waitMs` for a pending reply. When one is
 * popped, it is claimed into the in-flight set with a visibility timeout.
 * Returns null on timeout.
 *
 * Same crash-window trade-off as inbox.pull: BLPOP and ZADD are not atomic.
 */
export async function pullReply(
  ctx: TenantContext,
  waitMs: number,
): Promise<{ taskId: string; result: TaskResult; visibleUntil: Date } | null> {
  const waitSec = Math.max(0, Math.ceil(waitMs / 1000));
  const popped = await redis.blpop(replyInboxKey(ctx), waitSec);
  if (!popped) return null;

  const [, payload] = popped;
  let entry: ReplyInflightEntry;
  try {
    entry = JSON.parse(payload);
    if (!entry.taskId || !entry.result) throw new Error('malformed reply entry');
  } catch (err) {
    logger.error({ err, ctx }, 'Reply inbox payload malformed; dropping');
    return null;
  }

  const visibleUntilMs = Date.now() + BROKER_VISIBILITY_TIMEOUT_MS;
  const inflight: ReplyInflightEntry = {
    ...entry,
    reclaimCount: entry.reclaimCount ?? 0,
  };
  await redis.zadd(replyInflightKey(ctx), visibleUntilMs, JSON.stringify(inflight));

  return {
    taskId: entry.taskId,
    result: entry.result,
    visibleUntil: new Date(visibleUntilMs),
  };
}

/**
 * Non-destructive snapshot of the reply inbox, newest-first (LPUSH head).
 * Used by the peek endpoint and by the SSE stream's replay path. Does not
 * claim replies — visibility state is unchanged.
 */
export async function listReplies(ctx: TenantContext): Promise<ReplyInflightEntry[]> {
  const raws = await redis.lrange(replyInboxKey(ctx), 0, -1);
  const entries: ReplyInflightEntry[] = [];
  for (const raw of raws) {
    try {
      const entry: ReplyInflightEntry = JSON.parse(raw);
      if (entry.taskId && entry.result) entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries;
}

/** Result of calling ackReply. */
export type AckReplyOutcome = 'accepted' | 'already_acked' | 'reply_not_found';

/**
 * Ack a pulled reply, clearing in-flight state. Idempotent — a second ack for
 * the same taskId returns `already_acked`. The stored-result key is untouched
 * so direct-lookup still works until TTL expiry.
 */
export async function ackReply(ctx: TenantContext, taskId: string): Promise<AckReplyOutcome> {
  const raws = await redis.zrange(replyInflightKey(ctx), 0, -1);
  for (const raw of raws) {
    try {
      const entry: ReplyInflightEntry = JSON.parse(raw);
      if (entry.taskId === taskId) {
        const removed = await redis.zrem(replyInflightKey(ctx), raw);
        return removed > 0 ? 'accepted' : 'already_acked';
      }
    } catch {
      continue;
    }
  }
  return 'reply_not_found';
}

/** Peek at an in-flight reply entry by taskId without removing it. */
export async function peekInflightReply(
  ctx: TenantContext,
  taskId: string,
): Promise<ReplyInflightEntry | null> {
  const raws = await redis.zrange(replyInflightKey(ctx), 0, -1);
  for (const raw of raws) {
    try {
      const entry: ReplyInflightEntry = JSON.parse(raw);
      if (entry.taskId === taskId) return entry;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Direct lookup of a stored TaskResult by taskId. Returns null if the key has
 * expired or was never written. Used by GET /agents/:agentId/replies/:taskId
 * and, transitively, by MCP's nova_get_task_result fall-through.
 */
export async function getStoredResult(
  ctx: TenantContext,
  taskId: string,
): Promise<TaskResult | null> {
  const raw = await redis.get(taskResultKey(ctx, taskId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TaskResult;
  } catch {
    return null;
  }
}

/**
 * Sweep in-flight reply sets for expired entries. Redeliver up to the reclaim
 * ceiling; DLQ past that with `broker_reply_no_response`. Idempotent.
 */
export async function reclaimReplies(
  ctx: TenantContext,
): Promise<{ redelivered: number; deadLettered: number }> {
  const now = Date.now();
  const raws = await redis.zrangebyscore(replyInflightKey(ctx), '-inf', now);
  let redelivered = 0;
  let deadLettered = 0;

  for (const raw of raws) {
    let entry: ReplyInflightEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      await redis.zrem(replyInflightKey(ctx), raw);
      continue;
    }
    await redis.zrem(replyInflightKey(ctx), raw);

    if (entry.reclaimCount + 1 >= BROKER_RECLAIM_CEILING) {
      await writeDeadLetter(ctx, {
        taskId: entry.taskId,
        targetUrl: 'broker-reply',
        taskResult: entry.result,
        failureReason: 'broker_reply_no_response',
        httpStatus: 0,
        attemptCount: entry.reclaimCount + 1,
      });
      deadLettered += 1;
    } else {
      const updated: ReplyInflightEntry = { ...entry, reclaimCount: entry.reclaimCount + 1 };
      await redis.lpush(replyInboxKey(ctx), JSON.stringify(updated));
      redelivered += 1;
    }
  }

  return { redelivered, deadLettered };
}

/**
 * Iterate every broker-reply participant and run reclaimReplies. Called by
 * the reclaim worker every BROKER_RECLAIM_INTERVAL_MS.
 */
export async function reclaimAllReplies(): Promise<{ redelivered: number; deadLettered: number }> {
  const members = await redis.smembers(BROKER_REPLY_AGENTS_SET);
  let redelivered = 0;
  let deadLettered = 0;
  for (const member of members) {
    const [tenantId, agentId] = member.split(':', 2);
    if (!tenantId || !agentId) continue;
    const r = await reclaimReplies({ tenantId, agentId });
    redelivered += r.redelivered;
    deadLettered += r.deadLettered;
  }
  return { redelivered, deadLettered };
}

/** Remove an agent from the broker-reply participant set (on deregistration). */
export async function forgetBrokerReplyAgent(ctx: TenantContext): Promise<void> {
  await redis.pipeline()
    .srem(BROKER_REPLY_AGENTS_SET, memberKey(ctx))
    .del(replyInboxKey(ctx))
    .del(replyInflightKey(ctx))
    .del(replyInboxSeqKey(ctx))
    .exec();
}
