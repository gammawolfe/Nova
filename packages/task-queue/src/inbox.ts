// packages/task-queue/src/inbox.ts
import fsp from 'fs/promises';
import { redis } from './index';
import { TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { QueuedTask } from '@nova/shared/src/types';
import { logger } from '@nova/shared/src/logger';
import {
  BROKER_VISIBILITY_TIMEOUT_MS,
  BROKER_RECLAIM_CEILING,
} from '@nova/shared/src/broker-config';
import { writeDeadLetter } from './dead-letter';

// ── Key helpers ─────────────────────────────────────────────────────────────

export function inboxKey(ctx: TenantContext): string {
  return `nova:inbox:${ctx.tenantId}:${ctx.agentId}`;
}

export function inflightKey(ctx: TenantContext): string {
  return `nova:inflight:${ctx.tenantId}:${ctx.agentId}`;
}

/** Set of "tenantId:agentId" pairs that have at least one broker-mode agent. */
export const BROKER_AGENTS_SET = 'nova:broker-agents';

function memberKey(ctx: TenantContext): string {
  return `${ctx.tenantId}:${ctx.agentId}`;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface InflightEntry {
  taskId: string;
  task: QueuedTask;
  reclaimCount: number;
}

/**
 * Push a task onto the agent's inbox and register the agent as a broker
 * participant (used by the reclaim worker's iteration).
 */
export async function enqueue(ctx: TenantContext, task: QueuedTask): Promise<void> {
  const entry: InflightEntry = { taskId: task.taskId, task, reclaimCount: 0 };
  await redis.pipeline()
    .lpush(inboxKey(ctx), JSON.stringify(entry))
    .sadd(BROKER_AGENTS_SET, memberKey(ctx))
    .exec();
}

/**
 * Long-poll pull. Blocks up to `waitMs` for a task. When one is popped, it is
 * claimed into the in-flight set with a visibility timeout. Returns null on
 * timeout or if the popped task is past its TTL.
 *
 * Atomicity: BRPOPLPUSH-style atomic claim via Lua would be ideal but Redis
 * BLPOP does not support multi-command atomicity with ZADD. We accept a tiny
 * crash window (process dies between BRPOP and ZADD) — worst case the task is
 * lost from the inbox without being tracked in-flight. Non-blocking sweeps of
 * Redis can surface orphans via a follow-up patch if this ever bites.
 */
export async function pull(
  ctx: TenantContext,
  waitMs: number,
): Promise<{ task: QueuedTask; visibleUntil: Date } | null> {
  const waitSec = Math.max(0, Math.ceil(waitMs / 1000));
  // BLPOP returns [key, value] or null on timeout.
  const result = await redis.blpop(inboxKey(ctx), waitSec);
  if (!result) return null;

  const [, payload] = result;
  let entry: InflightEntry;
  try {
    entry = JSON.parse(payload);
    if (!entry.taskId || !entry.task) throw new Error('malformed entry');
  } catch (err) {
    logger.error({ err, ctx }, 'Inbox payload malformed; dropping');
    return null;
  }

  // Skip expired tasks — sender's TTL already passed
  if (new Date(entry.task.expiresAt) <= new Date()) {
    logger.info({ ctx, taskId: entry.taskId }, 'Inbox task TTL expired at pull; dropping');
    return null;
  }

  const visibleUntilMs = Date.now() + BROKER_VISIBILITY_TIMEOUT_MS;
  // Preserve reclaimCount from the entry (will be 0 on a fresh enqueue,
  // incremented on redelivery from reclaim).
  const inflight: InflightEntry = { ...entry, reclaimCount: entry.reclaimCount ?? 0 };
  await redis.zadd(inflightKey(ctx), visibleUntilMs, JSON.stringify(inflight));

  return { task: entry.task, visibleUntil: new Date(visibleUntilMs) };
}

/** Result of calling respond. */
export type RespondOutcome = 'accepted' | 'already_completed' | 'task_not_found';

/**
 * Complete an in-flight task. Finds the entry by taskId and removes it.
 * Callers are responsible for shipping the TaskResult to the sender's replyUrl
 * — this function only clears in-flight state.
 */
export async function respond(ctx: TenantContext, taskId: string): Promise<RespondOutcome> {
  const raws = await redis.zrange(inflightKey(ctx), 0, -1);
  for (const raw of raws) {
    try {
      const entry: InflightEntry = JSON.parse(raw);
      if (entry.taskId === taskId) {
        const removed = await redis.zrem(inflightKey(ctx), raw);
        return removed > 0 ? 'accepted' : 'already_completed';
      }
    } catch {
      continue;
    }
  }
  return 'task_not_found';
}

/**
 * Get the in-flight entry for a specific taskId. Used by the respond endpoint
 * to hydrate the QueuedTask before shipping to replyUrl.
 */
export async function peekInflight(ctx: TenantContext, taskId: string): Promise<InflightEntry | null> {
  const raws = await redis.zrange(inflightKey(ctx), 0, -1);
  for (const raw of raws) {
    try {
      const entry: InflightEntry = JSON.parse(raw);
      if (entry.taskId === taskId) return entry;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Sweep in-flight sets for expired entries. Redeliver up to reclaim ceiling;
 * dead-letter past that. Idempotent — safe to call repeatedly.
 */
export async function reclaim(ctx: TenantContext): Promise<{ redelivered: number; deadLettered: number }> {
  const now = Date.now();
  const raws = await redis.zrangebyscore(inflightKey(ctx), '-inf', now);
  let redelivered = 0;
  let deadLettered = 0;

  for (const raw of raws) {
    let entry: InflightEntry;
    try {
      entry = JSON.parse(raw);
    } catch {
      await redis.zrem(inflightKey(ctx), raw);
      continue;
    }
    await redis.zrem(inflightKey(ctx), raw);
    if (entry.reclaimCount + 1 >= BROKER_RECLAIM_CEILING) {
      await writeDeadLetter(ctx, {
        taskId: entry.taskId,
        targetUrl: 'broker',
        taskResult: {
          type: 'TaskResult',
          requestId: entry.taskId,
          status: 'error',
          error: { code: 'BROKER_TIMEOUT', message: 'Receiver did not respond within reclaim ceiling', retryable: false },
          auditToken: 'none',
          completedAt: new Date().toISOString(),
          schemaVersion: '1.0',
        },
        failureReason: 'broker_no_response',
        httpStatus: 0,
        attemptCount: entry.reclaimCount + 1,
      });
      deadLettered += 1;
    } else {
      const updated: InflightEntry = { ...entry, reclaimCount: entry.reclaimCount + 1 };
      await redis.lpush(inboxKey(ctx), JSON.stringify(updated));
      redelivered += 1;
    }
  }

  return { redelivered, deadLettered };
}

/**
 * Iterate every broker-participant agent (pairs of tenantId:agentId) and run
 * reclaim. Called by the reclaim worker in agent-connector every
 * BROKER_RECLAIM_INTERVAL_MS.
 */
export async function reclaimAll(): Promise<{ redelivered: number; deadLettered: number }> {
  const members = await redis.smembers(BROKER_AGENTS_SET);
  let redelivered = 0;
  let deadLettered = 0;
  for (const member of members) {
    const [tenantId, agentId] = member.split(':', 2);
    if (!tenantId || !agentId) continue;
    const r = await reclaim({ tenantId, agentId });
    redelivered += r.redelivered;
    deadLettered += r.deadLettered;
  }
  return { redelivered, deadLettered };
}

/**
 * Is this agent in broker mode? Defined as: active agent with no operatorUrl
 * and at least one real skill (not `__sender_only`).
 */
export async function isBrokerAgent(ctx: TenantContext): Promise<boolean> {
  try {
    const configPath = tenantDataPath(ctx, 'agent-config.json');
    const raw = await fsp.readFile(configPath, 'utf8');
    const cfg = JSON.parse(raw) as {
      status: string;
      operatorUrl?: string;
      skills?: Array<{ id: string }>;
    };
    if (cfg.status !== 'active') return false;
    if (cfg.operatorUrl) return false;
    const hasRealSkill = (cfg.skills ?? []).some(s => s.id !== '__sender_only');
    return hasRealSkill;
  } catch {
    return false;
  }
}

/** Remove an agent from the broker participant set (called on deregistration). */
export async function forgetBrokerAgent(ctx: TenantContext): Promise<void> {
  await redis.pipeline()
    .srem(BROKER_AGENTS_SET, memberKey(ctx))
    .del(inboxKey(ctx))
    .del(inflightKey(ctx))
    .exec();
}
