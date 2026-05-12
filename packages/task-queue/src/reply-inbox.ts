// packages/task-queue/src/reply-inbox.ts
//
// Broker-mode reply inbox — symmetric to inbox.ts but flowing in the
// opposite direction. When a broker-mode sender (no public webhook)
// targets an agent without a `replyTo` URL, the recipient's respond
// handler enqueues the TaskResult here. The sender pulls via
// nova_next_reply (long-poll, at-least-once with visibility timeout)
// and acks via nova_ack_reply.
//
// Implemented as a thin wrapper over VisibilityQueue (see
// visibility-queue.ts). Reply-inbox-specific behaviour:
//
//   - On-wire inner field name is `result` (not `task`), matching the
//     existing format so live entries don't need migration.
//   - Notification shape is { seq, taskId, enqueuedAt } — no intent
//     field (replies don't carry an intent; they're outputs).
//   - On reclaim exhaustion, DLQ carries the original TaskResult
//     unchanged (the receiver already produced it), with failureReason
//     `broker_reply_no_response`.
//   - Enqueue atomically writes an extra direct-lookup key
//     (taskResultKey) via SETEX so GET /replies/:taskId can serve the
//     stored TaskResult after the queue entry has been popped + acked.

import { TenantContext } from '@nova/shared/src/tenant';
import { TaskResult } from '@nova/shared/src/types';
import {
  BROKER_VISIBILITY_TIMEOUT_MS,
  BROKER_RECLAIM_CEILING,
  BROKER_REPLY_RESULT_TTL_SECONDS,
  BROKER_QUEUE_SEQ_TTL_SECONDS,
} from '@nova/shared/src/broker-config';
import { getSharedRedis } from '@nova/shared/src/redis';
import {
  VisibilityQueue,
  VisibilityEntry,
  KeyBuilder,
} from './visibility-queue';

// ── Key helpers (preserved as public exports for callers) ──────────────────

export function replyInboxKey(ctx: TenantContext): string {
  return `nova:reply-inbox:${ctx.tenantId}:${ctx.agentId}`;
}

export function replyInflightKey(ctx: TenantContext): string {
  return `nova:reply-inflight:${ctx.tenantId}:${ctx.agentId}`;
}

export function replyInboxNotifyChannel(ctx: TenantContext): string {
  return `nova:reply-inbox-notify:${ctx.tenantId}:${ctx.agentId}`;
}

export function replyInboxSeqKey(ctx: TenantContext): string {
  return `nova:reply-inbox-seq:${ctx.tenantId}:${ctx.agentId}`;
}

export function taskResultKey(ctx: TenantContext, taskId: string): string {
  return `nova:task-result:${ctx.tenantId}:${ctx.agentId}:${taskId}`;
}

/** Set of "tenantId:agentId" pairs that have at least one pending reply. */
export const BROKER_REPLY_AGENTS_SET = 'nova:broker-reply-agents';

const replyKeys: KeyBuilder = {
  list: replyInboxKey,
  inflight: replyInflightKey,
  notifyChannel: replyInboxNotifyChannel,
  seq: replyInboxSeqKey,
};

// ── Public types (preserved on-wire field names) ───────────────────────────

export interface ReplyInflightEntry {
  taskId: string;
  result: TaskResult;
  reclaimCount: number;
  seq?: number;
}

export interface ReplyInboxNotification {
  seq: number;
  taskId: string;
  enqueuedAt: string;
}

// ── VisibilityQueue instance ───────────────────────────────────────────────

const queue = new VisibilityQueue<TaskResult, ReplyInboxNotification>({
  keys: replyKeys,
  participantSet: BROKER_REPLY_AGENTS_SET,
  visibilityTimeoutMs: BROKER_VISIBILITY_TIMEOUT_MS,
  seqTtlSeconds: BROKER_QUEUE_SEQ_TTL_SECONDS,
  reclaimCeiling: BROKER_RECLAIM_CEILING,
  logLabel: 'reply-inbox',

  buildNotification: ({ seq, taskId }) => ({
    seq,
    taskId,
    enqueuedAt: new Date().toISOString(),
  }),

  // Preserve the existing on-wire field name `result` (not `inner`) so
  // entries written by older code keep deserialising across a deploy.
  serializeEntry: (entry) => JSON.stringify({
    taskId: entry.taskId,
    result: entry.inner,
    reclaimCount: entry.reclaimCount,
    ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
  }),
  parseEntry: (raw) => {
    try {
      const e = JSON.parse(raw);
      if (!e || typeof e !== 'object' || !e.taskId || !e.result) return null;
      return {
        taskId: e.taskId,
        inner: e.result as TaskResult,
        reclaimCount: typeof e.reclaimCount === 'number' ? e.reclaimCount : 0,
        seq: typeof e.seq === 'number' ? e.seq : undefined,
      };
    } catch {
      return null;
    }
  },

  // Reply-inbox DLQ carries the original TaskResult — the receiver
  // already produced it, so there's nothing to synthesise here. The
  // failure mode is delivery-side: the sender didn't pull within the
  // reclaim ceiling.
  buildDeadLetter: ({ inner }) => ({
    targetUrl: 'broker-reply',
    failureReason: 'broker_reply_no_response',
    taskResult: inner,
  }),

  // Reply-inbox extends the enqueue pipeline with a SETEX for the
  // direct-lookup TaskResult key. This guarantees that GET
  // /replies/:taskId can find the result alongside the queue entry,
  // and the two writes are atomic — a crash between them is
  // impossible because they ship in the same pipeline.
  extraEnqueuePipelineOps: ({ pipe, ctx, taskId, inner }) => {
    pipe.setex(
      taskResultKey(ctx, taskId),
      BROKER_REPLY_RESULT_TTL_SECONDS,
      JSON.stringify(inner),
    );
  },
});

// ── Public API (thin shims over VisibilityQueue) ───────────────────────────

/**
 * Enqueue a TaskResult to the sender's reply inbox AND persist it by
 * taskId for direct lookup. Both writes share the same pipeline so they
 * either both succeed or both fail — handled by VisibilityQueue's
 * extraEnqueuePipelineOps hook.
 *
 * The stored-result key lives out its 24h TTL independently of inbox
 * consumption — ackReply only clears the inbox/in-flight state; the
 * direct-lookup key remains retrievable until TTL expiry so
 * nova_get_task_result keeps working.
 */
export async function enqueueReply(
  senderCtx: TenantContext,
  taskId: string,
  result: TaskResult,
): Promise<void> {
  return queue.enqueue(senderCtx, taskId, result);
}

/**
 * Long-poll pull. Returns null on timeout. The popped reply is claimed
 * into the in-flight set with a 5-minute visibility timeout — caller
 * must ack before it expires or the reply is redelivered.
 */
export async function pullReply(
  ctx: TenantContext,
  waitMs: number,
): Promise<{ taskId: string; result: TaskResult; visibleUntil: Date } | null> {
  const r = await queue.pull(ctx, waitMs);
  if (!r) return null;
  return { taskId: r.taskId, result: r.inner, visibleUntil: r.visibleUntil };
}

/** Non-destructive snapshot of the reply-inbox, newest-first. */
export async function listReplies(ctx: TenantContext): Promise<ReplyInflightEntry[]> {
  const entries = await queue.list(ctx);
  return entries.map(toPublicEntry);
}

/**
 * Wire-level outcome names for the ack endpoint. Preserved as
 * reply-inbox-specific values so HTTP responses don't have to rename
 * from 'reply_not_found' / 'already_acked' (which a2a-server's route
 * already exposes to clients). Maps from the queue's generic
 * RespondOutcome under the hood.
 */
export type AckReplyOutcome = 'accepted' | 'already_acked' | 'reply_not_found';

/**
 * Ack a pulled reply, clearing in-flight state. Idempotent — a second
 * call returns 'already_acked'. The stored-result key is untouched so
 * direct-lookup keeps working until TTL expiry.
 */
export async function ackReply(ctx: TenantContext, taskId: string): Promise<AckReplyOutcome> {
  const outcome = await queue.respond(ctx, taskId);
  switch (outcome) {
    case 'accepted': return 'accepted';
    case 'already_completed': return 'already_acked';
    case 'task_not_found': return 'reply_not_found';
  }
}

/** Peek at an in-flight reply entry by taskId without removing it. */
export async function peekInflightReply(
  ctx: TenantContext,
  taskId: string,
): Promise<ReplyInflightEntry | null> {
  const entry = await queue.peekInflight(ctx, taskId);
  return entry ? toPublicEntry(entry) : null;
}

/**
 * Direct lookup of a stored TaskResult by taskId. Returns null if the
 * 24h TTL has expired or the key was never written. Used by
 * GET /agents/:agentId/replies/:taskId and by MCP's
 * nova_get_task_result fall-through.
 */
export async function getStoredResult(
  ctx: TenantContext,
  taskId: string,
): Promise<TaskResult | null> {
  const redis = getSharedRedis();
  const raw = await redis.get(taskResultKey(ctx, taskId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TaskResult;
  } catch {
    return null;
  }
}

export async function reclaimReplies(
  ctx: TenantContext,
): Promise<{ redelivered: number; deadLettered: number }> {
  return queue.reclaim(ctx);
}

export async function reclaimAllReplies(): Promise<{ redelivered: number; deadLettered: number }> {
  return queue.reclaimAll();
}

/** Remove all reply-inbox state for an agent (called on deregistration). */
export async function forgetBrokerReplyAgent(ctx: TenantContext): Promise<void> {
  return queue.forget(ctx);
}

// ── Internal helpers ───────────────────────────────────────────────────────

function toPublicEntry(entry: VisibilityEntry<TaskResult>): ReplyInflightEntry {
  return {
    taskId: entry.taskId,
    result: entry.inner,
    reclaimCount: entry.reclaimCount,
    ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
  };
}
