// packages/task-queue/src/inbox.ts
//
// Per-(tenant, agent) inbox: tasks enqueued here are pulled by broker-mode
// receivers via long-poll (a2a-server's /agents/:id/inbox endpoint). The
// inbox is a Redis list (LPUSH at the head, BLPOP from the tail); claimed
// items move to a sorted set keyed by visibility deadline so an unresponded
// task is redelivered by the reclaim worker.
//
// All the actual queue plumbing lives in visibility-queue.ts. This module
// owns the inbox-specific config: key names, the on-wire field name for
// the inner task payload (`task`), the notification shape, the DLQ
// taskResult shape on reclaim exhaustion, and the pull-time filter that
// drops tasks past their sender-side TTL.

import fsp from 'fs/promises';
import { TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { QueuedTask } from '@nova/shared/src/types';
import {
  BROKER_VISIBILITY_TIMEOUT_MS,
  BROKER_RECLAIM_CEILING,
  BROKER_QUEUE_SEQ_TTL_SECONDS,
} from '@nova/shared/src/broker-config';
import {
  VisibilityQueue,
  VisibilityEntry,
  PullResult,
  KeyBuilder,
  RespondOutcome,
} from './visibility-queue';

// ── Key helpers (preserved as public exports for callers) ──────────────────

export function inboxKey(ctx: TenantContext): string {
  return `nova:inbox:${ctx.tenantId}:${ctx.agentId}`;
}

export function inflightKey(ctx: TenantContext): string {
  return `nova:inflight:${ctx.tenantId}:${ctx.agentId}`;
}

export function inboxNotifyChannel(ctx: TenantContext): string {
  return `nova:inbox-notify:${ctx.tenantId}:${ctx.agentId}`;
}

export function inboxSeqKey(ctx: TenantContext): string {
  return `nova:inbox-seq:${ctx.tenantId}:${ctx.agentId}`;
}

/** Set of "tenantId:agentId" pairs that have at least one broker-mode agent. */
export const BROKER_AGENTS_SET = 'nova:broker-agents';

const inboxKeys: KeyBuilder = {
  list: inboxKey,
  inflight: inflightKey,
  notifyChannel: inboxNotifyChannel,
  seq: inboxSeqKey,
};

// ── Public types (preserved on-wire field names) ───────────────────────────

export interface InflightEntry {
  taskId: string;
  task: QueuedTask;
  reclaimCount: number;
  /** Monotonic per-(tenant,agent) seq assigned at first enqueue; used as
   *  the SSE id so resuming subscribers can skip already-delivered events.
   *  Absent on pre-push-subscriptions entries. */
  seq?: number;
}

export interface InboxNotification {
  seq: number;
  taskId: string;
  intent: string;
  enqueuedAt: string;
}

// ── VisibilityQueue instance ───────────────────────────────────────────────

const queue = new VisibilityQueue<QueuedTask, InboxNotification>({
  keys: inboxKeys,
  participantSet: BROKER_AGENTS_SET,
  visibilityTimeoutMs: BROKER_VISIBILITY_TIMEOUT_MS,
  seqTtlSeconds: BROKER_QUEUE_SEQ_TTL_SECONDS,
  reclaimCeiling: BROKER_RECLAIM_CEILING,
  logLabel: 'inbox',

  buildNotification: ({ seq, taskId, inner }) => ({
    seq,
    taskId,
    intent: inner.intent,
    enqueuedAt: new Date().toISOString(),
  }),

  // Preserve the existing on-wire field name `task` (not `inner`) so
  // entries written by older code keep deserialising. Migration of in-
  // flight tasks across deploys is avoided.
  serializeEntry: (entry) => JSON.stringify({
    taskId: entry.taskId,
    task: entry.inner,
    reclaimCount: entry.reclaimCount,
    ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
  }),
  parseEntry: (raw) => {
    try {
      const e = JSON.parse(raw);
      if (!e || typeof e !== 'object' || !e.taskId || !e.task) return null;
      return {
        taskId: e.taskId,
        inner: e.task as QueuedTask,
        reclaimCount: typeof e.reclaimCount === 'number' ? e.reclaimCount : 0,
        seq: typeof e.seq === 'number' ? e.seq : undefined,
      };
    } catch {
      return null;
    }
  },

  buildDeadLetter: ({ taskId, attemptCount }) => ({
    targetUrl: 'broker',
    failureReason: 'broker_no_response',
    taskResult: {
      type: 'TaskResult',
      requestId: taskId,
      status: 'error',
      error: {
        code: 'BROKER_TIMEOUT',
        message: 'Receiver did not respond within reclaim ceiling',
        retryable: false,
      },
      auditToken: 'none',
      completedAt: new Date().toISOString(),
      schemaVersion: '1.0',
    },
  }),

  // Drop entries whose sender-side TTL has already passed before claiming.
  // Better than handing the receiver work that's guaranteed to be reclaimed
  // and dead-lettered as expired.
  pullFilter: ({ entry }) => new Date(entry.inner.expiresAt) > new Date(),
});

// ── Public API (thin shims over VisibilityQueue) ───────────────────────────

/**
 * Push a task onto the agent's inbox and publish a notification. The
 * Redis pipeline registers the agent as a broker participant
 * (BROKER_AGENTS_SET) so reclaimAll can iterate it; SSE subscribers
 * react to the notification.
 */
export async function enqueue(ctx: TenantContext, task: QueuedTask): Promise<void> {
  return queue.enqueue(ctx, task.taskId, task);
}

/**
 * Long-poll pull. Returns null on timeout or when the popped task is
 * past its TTL (filtered out by pullFilter without claiming).
 */
export async function pull(
  ctx: TenantContext,
  waitMs: number,
): Promise<{ task: QueuedTask; visibleUntil: Date } | null> {
  const r = await queue.pull(ctx, waitMs);
  if (!r) return null;
  return { task: r.inner, visibleUntil: r.visibleUntil };
}

/** Non-destructive snapshot of the inbox, newest-first. */
export async function list(ctx: TenantContext): Promise<InflightEntry[]> {
  const entries = await queue.list(ctx);
  return entries.map(toPublicEntry);
}

export type { RespondOutcome } from './visibility-queue';

/**
 * Complete an in-flight task. Finds the entry by taskId and removes it
 * from the inflight set. Callers are responsible for delivering the
 * TaskResult to the sender's replyUrl / reply-inbox.
 */
export async function respond(ctx: TenantContext, taskId: string): Promise<RespondOutcome> {
  return queue.respond(ctx, taskId);
}

/** Get the in-flight entry for a specific taskId without removing it. */
export async function peekInflight(
  ctx: TenantContext,
  taskId: string,
): Promise<InflightEntry | null> {
  const entry = await queue.peekInflight(ctx, taskId);
  return entry ? toPublicEntry(entry) : null;
}

export async function reclaim(
  ctx: TenantContext,
): Promise<{ redelivered: number; deadLettered: number }> {
  return queue.reclaim(ctx);
}

export async function reclaimAll(): Promise<{ redelivered: number; deadLettered: number }> {
  return queue.reclaimAll();
}

// ── Broker-mode detection (cached) ─────────────────────────────────────────
//
// `isBrokerAgent` runs on the hot path: agent-connector's processTask
// calls it for every task to decide whether to deliver via webhook or
// enqueue to the broker inbox. Reading agent-config.json from disk per
// call was identified as a hot-path cost in the codebase review (#5).
//
// The cache mirrors schema-validator.ts's 30-second TTL pattern: broker
// mode is a function of the agent's configured operatorUrl + skills,
// which change rarely (admin-api update or approve). 30s staleness is
// acceptable; invalidateIsBrokerAgentCache lets the admin-api evict an
// entry after an update if they ever share a process (they don't today).

const IS_BROKER_TTL_MS = 30_000;
const isBrokerCache = new Map<string, { value: boolean; expiresAt: number }>();

function isBrokerCacheKey(ctx: TenantContext): string {
  return `${ctx.tenantId}:${ctx.agentId}`;
}

/**
 * Is this agent in broker mode? Defined as: active agent with no
 * operatorUrl and at least one real skill (not `__sender_only`).
 * Result cached per (tenant, agent) for 30 seconds.
 */
export async function isBrokerAgent(ctx: TenantContext): Promise<boolean> {
  const key = isBrokerCacheKey(ctx);
  const cached = isBrokerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value = false;
  try {
    const configPath = tenantDataPath(ctx, 'agent-config.json');
    const raw = await fsp.readFile(configPath, 'utf8');
    const cfg = JSON.parse(raw) as {
      status: string;
      operatorUrl?: string;
      skills?: Array<{ id: string }>;
    };
    if (cfg.status === 'active' && !cfg.operatorUrl) {
      value = (cfg.skills ?? []).some(s => s.id !== '__sender_only');
    }
  } catch {
    value = false;
  }

  isBrokerCache.set(key, { value, expiresAt: Date.now() + IS_BROKER_TTL_MS });
  return value;
}

/**
 * Evict the broker-mode cache entry for one (tenant, agent). Exposed so
 * an admin-api running in the same process as the inbox could force a
 * refresh after an agent update; they don't share a process today, but
 * the seam is cheap and removes a foot-gun for future co-location.
 */
export function invalidateIsBrokerAgentCache(ctx: TenantContext): void {
  isBrokerCache.delete(isBrokerCacheKey(ctx));
}

/** Remove an agent from broker state (called on deregistration). */
export async function forgetBrokerAgent(ctx: TenantContext): Promise<void> {
  invalidateIsBrokerAgentCache(ctx);
  return queue.forget(ctx);
}

// ── Internal helpers ───────────────────────────────────────────────────────

function toPublicEntry(entry: VisibilityEntry<QueuedTask>): InflightEntry {
  return {
    taskId: entry.taskId,
    task: entry.inner,
    reclaimCount: entry.reclaimCount,
    ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
  };
}
