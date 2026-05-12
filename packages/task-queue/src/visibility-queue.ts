// packages/task-queue/src/visibility-queue.ts
//
// Generic Redis-backed visibility-timeout queue. Extracts the shared
// behaviour that `inbox.ts` and `reply-inbox.ts` used to implement in
// parallel — same Redis-list-as-queue, same sorted-set-as-inflight,
// same reclaim-ceiling, same DLQ-on-exhaustion pattern — into one
// reusable class.
//
// Each consumer instantiates `VisibilityQueue<T, N>` with:
//   - The Redis keys this queue uses (list, inflight, notify channel, seq).
//   - The participant-set name (so reclaimAll can iterate active members).
//   - Serialize/parse callbacks that preserve the existing on-wire shape
//     (inbox uses `task` as the inner field name; reply-inbox uses `result`),
//     so a refactor doesn't migrate live in-flight entries.
//   - A buildNotification callback shaping the pub/sub payload.
//   - A buildDeadLetter callback shaping the DLQ entry on reclaim
//     exhaustion (inbox emits a synthetic BROKER_TIMEOUT TaskResult;
//     reply-inbox passes through the original TaskResult).
//   - Optional pullFilter to drop entries at pull time without claiming
//     (inbox uses this to drop tasks past their sender TTL).
//   - Optional extraEnqueuePipelineOps to extend the atomic enqueue
//     pipeline with consumer-specific writes (reply-inbox uses this to
//     SETEX the direct-lookup TaskResult key in the same transaction).
//
// The class is intentionally narrow: each method maps 1:1 to one of the
// inbox-side primitives, with no extra state or scheduling logic. The
// reclaim worker (in agent-connector) drives reclaimAll on an interval.

import { randomBytes } from 'crypto';
import type { ChainableCommander } from 'ioredis';
import { TenantContext } from '@nova/shared/src/tenant';
import { TaskResult } from '@nova/shared/src/types';
import { getSharedRedis } from '@nova/shared/src/redis';
import { logger } from '@nova/shared/src/logger';
import {
  BROKER_HEARTBEAT_TTL_SECONDS,
  BROKER_HEARTBEAT_REFRESH_MS,
} from '@nova/shared/src/broker-config';
import { writeDeadLetter, DeadLetterEntry } from './dead-letter';

export interface KeyBuilder {
  list(ctx: TenantContext): string;
  inflight(ctx: TenantContext): string;
  notifyChannel(ctx: TenantContext): string;
  seq(ctx: TenantContext): string;
}

export interface VisibilityEntry<T> {
  taskId: string;
  /** Inner payload — caller-defined shape (QueuedTask, TaskResult, …). */
  inner: T;
  /** How many times this entry has been redelivered by the reclaim worker. */
  reclaimCount: number;
  /** Monotonic per-(tenant,agent) sequence assigned at first enqueue. */
  seq?: number | undefined;
}

export interface VisibilityQueueConfig<T, N> {
  /** Redis keys this queue reads/writes for a given tenant + agent. */
  keys: KeyBuilder;
  /** Participant-set key for cross-(tenant,agent) reclaim iteration. */
  participantSet: string;
  /** In-flight visibility timeout, milliseconds. */
  visibilityTimeoutMs: number;
  /** TTL on the seq counter (seconds). */
  seqTtlSeconds: number;
  /** Number of reclaim attempts before DLQ. */
  reclaimCeiling: number;
  /** Human-readable label for log lines about this queue. */
  logLabel: string;

  /**
   * Build the pub/sub notification payload from an enqueued entry. The
   * notification is JSON-encoded and published on the queue's notify
   * channel; SSE bridges consume it.
   */
  buildNotification(args: { seq: number; taskId: string; inner: T }): N;

  /**
   * Encode an entry for storage in Redis. The wire format is consumer-
   * specific (inbox uses `task: T`, reply-inbox uses `result: T`) so this
   * callback owns the exact field layout. Must produce JSON that
   * `parseEntry` can read back.
   */
  serializeEntry(entry: VisibilityEntry<T>): string;

  /**
   * Decode an entry from its Redis-stored JSON form. Returns null when
   * the payload is malformed or missing required fields; the caller
   * either drops it or moves it to DLQ depending on the context.
   */
  parseEntry(raw: string): VisibilityEntry<T> | null;

  /**
   * Construct the dead-letter parameters for an entry that exhausted
   * its reclaim attempts. Different consumers map this differently:
   * inbox synthesizes an error TaskResult; reply-inbox passes through
   * the original TaskResult that the receiver had already produced.
   */
  buildDeadLetter(args: {
    taskId: string;
    inner: T;
    attemptCount: number;
  }): {
    taskResult: TaskResult;
    targetUrl: string;
    failureReason: DeadLetterEntry['failureReason'];
  };

  /**
   * Optional: extend the atomic enqueue pipeline with consumer-specific
   * Redis operations. Called inside `enqueue` after the standard ops
   * (LPUSH, SADD, etc.) are queued but before exec(). reply-inbox uses
   * this to add a SETEX for the direct-lookup TaskResult key in the
   * same transaction.
   */
  extraEnqueuePipelineOps?(args: {
    pipe: ChainableCommander;
    ctx: TenantContext;
    taskId: string;
    inner: T;
  }): void;

  /**
   * Optional: filter entries at pull time. Returning false drops the
   * entry without claiming. inbox uses this to drop tasks past their
   * sender-side TTL (no point claiming work that's already expired).
   */
  pullFilter?(args: { entry: VisibilityEntry<T> }): boolean;
}

export interface PullResult<T> {
  taskId: string;
  inner: T;
  reclaimCount: number;
  visibleUntil: Date;
}

export type RespondOutcome = 'accepted' | 'already_completed' | 'task_not_found';

/**
 * Cap on per-iteration concurrency inside reclaimAll. Each chunk fires
 * one reclaim per (tenant, agent) in parallel; the next chunk waits for
 * the current one to settle. Sized to keep total in-flight Redis
 * commands bounded even when the participant set grows large.
 */
const RECLAIM_ALL_CHUNK = 16;

/**
 * Per-process identifier used to key this process's holding lists and
 * heartbeat key. Generated once at module load; stable across all
 * VisibilityQueue instances in the same Node process so a single
 * heartbeat key represents the whole process's liveness.
 */
const PROCESS_ID = randomBytes(8).toString('hex');

/** Compute the heartbeat key for any process ID (own or other). */
function heartbeatKeyFor(processId: string): string {
  return `nova:vq-heartbeat:${processId}`;
}

/** Heartbeat key for the current process. */
const HEARTBEAT_KEY = heartbeatKeyFor(PROCESS_ID);

let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatReady: Promise<void> | null = null;

/**
 * Start (idempotently) this process's heartbeat. The first call writes
 * the heartbeat key and starts a refresh interval; subsequent calls
 * return the same promise. Awaiting this guarantees the heartbeat key
 * exists in Redis — important because pull() SADDs this process into
 * the per-(tenant, agent) processor registry immediately after, and we
 * don't want any orphan sweeper to ever observe "in registry but no
 * heartbeat" for a live process. unref() so the interval doesn't keep
 * the event loop alive at shutdown.
 */
function ensureHeartbeat(): Promise<void> {
  if (heartbeatReady) return heartbeatReady;
  const redis = getSharedRedis();
  heartbeatReady = (async () => {
    await redis.set(HEARTBEAT_KEY, '1', 'EX', BROKER_HEARTBEAT_TTL_SECONDS);
    heartbeatTimer = setInterval(() => {
      redis.set(HEARTBEAT_KEY, '1', 'EX', BROKER_HEARTBEAT_TTL_SECONDS).catch(err => {
        logger.warn({ err }, 'visibility-queue: heartbeat refresh failed');
      });
    }, BROKER_HEARTBEAT_REFRESH_MS);
    heartbeatTimer.unref();
  })();
  return heartbeatReady;
}

/**
 * Stop the heartbeat refresh loop and clear the heartbeat key. Useful
 * for tests and for clean shutdowns; on unclean exit the heartbeat key
 * ages out via its TTL and the sweep notices within one
 * BROKER_RECLAIM_INTERVAL_MS.
 */
export async function stopHeartbeat(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatReady = null;
  try {
    await getSharedRedis().del(HEARTBEAT_KEY);
  } catch (err) {
    logger.warn({ err }, 'visibility-queue: heartbeat cleanup failed');
  }
}

/** Exposed for tests; production callers should not depend on this value. */
export function currentProcessId(): string {
  return PROCESS_ID;
}

/**
 * Redis-backed visibility-timeout queue. Each method is a primitive on
 * top of the LPUSH/BLPOP + sorted-set inflight pattern; consumers stitch
 * them together into their own public APIs (e.g. inbox.ts's `enqueue`,
 * `pull`, `respond`).
 */
export class VisibilityQueue<T, N> {
  constructor(private readonly config: VisibilityQueueConfig<T, N>) {}

  /**
   * Parallel index keyed by taskId, value = the same serialized entry
   * stored in the inflight zset. Lets `peekInflight` and `respond`
   * resolve a taskId to its raw entry without iterating the zset.
   * Populated by `pull`, cleared by `respond`/`reclaim`/`forget` —
   * always in the same MULTI as the zset write so the two structures
   * cannot drift.
   */
  private inflightHashKey(ctx: TenantContext): string {
    return `${this.config.keys.inflight(ctx)}:by-id`;
  }

  /**
   * Per-process holding list — entries land here via BLMOVE before
   * being claimed into inflight, so a process crash mid-pull leaves
   * the entry recoverable by the orphan sweep. Keyed by PROCESS_ID so
   * each process owns its own holding lists and concurrent processes
   * never step on each other's in-progress claims.
   */
  private holdingListKey(ctx: TenantContext, processId: string = PROCESS_ID): string {
    return `${this.config.keys.list(ctx)}:holding:${processId}`;
  }

  /**
   * Per-(tenant, agent) set of process IDs that have ever held entries
   * in this queue. The orphan sweep iterates this set to find holding
   * lists worth checking; entries get added on first pull and removed
   * by forget() or once the holding list is empty and the owner is
   * confirmed dead.
   */
  private processorsKey(ctx: TenantContext): string {
    return `${this.config.keys.inflight(ctx)}:processors`;
  }

  // ── Enqueue ────────────────────────────────────────────────────────────

  /**
   * Push an entry onto the queue and publish a notification. The
   * sequence increment + pipeline writes (LPUSH, SADD participant,
   * PUBLISH) plus any caller-extension ops happen as a single Redis
   * pipeline — a crash mid-call can lose the request but cannot leave
   * a partial state (notification without queue entry, or vice versa).
   */
  async enqueue(ctx: TenantContext, taskId: string, inner: T): Promise<void> {
    const redis = getSharedRedis();
    const seq = await redis.incr(this.config.keys.seq(ctx));
    const entry: VisibilityEntry<T> = { taskId, inner, reclaimCount: 0, seq };
    const notification = this.config.buildNotification({ seq, taskId, inner });

    const pipe = redis.pipeline()
      .expire(this.config.keys.seq(ctx), this.config.seqTtlSeconds)
      .lpush(this.config.keys.list(ctx), this.config.serializeEntry(entry))
      .sadd(this.config.participantSet, `${ctx.tenantId}:${ctx.agentId}`)
      .publish(this.config.keys.notifyChannel(ctx), JSON.stringify(notification));

    this.config.extraEnqueuePipelineOps?.({ pipe, ctx, taskId, inner });

    await pipe.exec();
  }

  // ── Pull ───────────────────────────────────────────────────────────────

  /**
   * Long-poll the queue and claim the next entry into the in-flight
   * set with a visibility deadline. Crash-safe: the payload first
   * atomically BLMOVEs from the queue into a per-process holding list,
   * then a MULTI promotes it into the inflight zset + by-id hash and
   * removes it from the holding list. If the process dies between the
   * BLMOVE and the MULTI, the orphan sweep (recoverOrphans) recovers
   * the entry back onto the queue once this process's heartbeat
   * expires.
   *
   * Returns null on long-poll timeout, malformed payload (dropped
   * from the holding list), or pullFilter rejection (also dropped).
   */
  async pull(ctx: TenantContext, waitMs: number): Promise<PullResult<T> | null> {
    const redis = getSharedRedis();
    const waitSec = Math.max(0, Math.ceil(waitMs / 1000));
    const queueKey = this.config.keys.list(ctx);
    const holdingKey = this.holdingListKey(ctx);

    // Heartbeat key must exist in Redis BEFORE we advertise this
    // process in the processor registry. Otherwise an orphan sweep
    // racing us could see "registered, no heartbeat" and steal our
    // about-to-be-claimed holding-list entry.
    await ensureHeartbeat();
    // SADD is idempotent and cheap; we don't bother caching the "already
    // registered" flag locally — Redis is the source of truth and the
    // cost is one round-trip per pull, dwarfed by the BLMOVE wait.
    await redis.sadd(this.processorsKey(ctx), PROCESS_ID);

    // BLMOVE atomically pops from the queue tail (matching BLPOP
    // semantics — LPUSH at head, oldest at tail) and pushes to the
    // holding-list head. If the process crashes here, the entry is
    // safe in the holding list until the sweep finds it.
    const payload = await redis.blmove(queueKey, holdingKey, 'RIGHT', 'LEFT', waitSec);
    if (!payload) return null;

    const entry = this.config.parseEntry(payload);
    if (!entry) {
      logger.error({ ctx, label: this.config.logLabel }, 'visibility-queue: pull payload malformed; dropping');
      await redis.lrem(holdingKey, 1, payload);
      return null;
    }

    if (this.config.pullFilter && !this.config.pullFilter({ entry })) {
      logger.info(
        { ctx, taskId: entry.taskId, label: this.config.logLabel },
        'visibility-queue: entry filtered at pull; dropping',
      );
      await redis.lrem(holdingKey, 1, payload);
      return null;
    }

    const visibleUntilMs = Date.now() + this.config.visibilityTimeoutMs;
    const inflightEntry: VisibilityEntry<T> = {
      taskId: entry.taskId,
      inner: entry.inner,
      reclaimCount: entry.reclaimCount,
      ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
    };
    const serialized = this.config.serializeEntry(inflightEntry);
    // Promote: inflight zset + by-id hash + remove from holding, all in
    // one MULTI. After this point a crash leaves the entry in the
    // inflight set where reclaim handles it; the holding list is empty.
    await redis.multi()
      .zadd(this.config.keys.inflight(ctx), visibleUntilMs, serialized)
      .hset(this.inflightHashKey(ctx), entry.taskId, serialized)
      .lrem(holdingKey, 1, payload)
      .exec();

    return {
      taskId: entry.taskId,
      inner: entry.inner,
      reclaimCount: entry.reclaimCount,
      visibleUntil: new Date(visibleUntilMs),
    };
  }

  // ── List (non-destructive) ─────────────────────────────────────────────

  /**
   * Snapshot the pending queue, newest-first. Does not claim anything;
   * the entries remain in the queue for the next pull. Used by peek
   * endpoints and SSE replay paths.
   */
  async list(ctx: TenantContext): Promise<VisibilityEntry<T>[]> {
    const redis = getSharedRedis();
    const raws = await redis.lrange(this.config.keys.list(ctx), 0, -1);
    const entries: VisibilityEntry<T>[] = [];
    for (const raw of raws) {
      const e = this.config.parseEntry(raw);
      if (e) entries.push(e);
    }
    return entries;
  }

  // ── In-flight operations (by taskId) ───────────────────────────────────

  /**
   * Find an in-flight entry by taskId without removing it. O(1) via
   * the parallel by-id hash populated by `pull`. Falls back to a zset
   * scan if the hash is missing the entry — covers entries written by
   * pre-hash deploys that may still be in flight during the rollout.
   */
  async peekInflight(ctx: TenantContext, taskId: string): Promise<VisibilityEntry<T> | null> {
    const redis = getSharedRedis();
    const raw = await redis.hget(this.inflightHashKey(ctx), taskId);
    if (raw) {
      const entry = this.config.parseEntry(raw);
      if (entry) return entry;
    }
    return this.peekInflightViaScan(ctx, taskId);
  }

  private async peekInflightViaScan(
    ctx: TenantContext,
    taskId: string,
  ): Promise<VisibilityEntry<T> | null> {
    const redis = getSharedRedis();
    const raws = await redis.zrange(this.config.keys.inflight(ctx), 0, -1);
    for (const raw of raws) {
      const entry = this.config.parseEntry(raw);
      if (entry?.taskId === taskId) return entry;
    }
    return null;
  }

  /**
   * Remove an in-flight entry by taskId. Returns 'accepted' on the
   * removal that wins, 'already_completed' if a concurrent caller (or
   * a reclaim sweep) already removed it, 'task_not_found' if nothing
   * with that taskId is currently in flight.
   *
   * Fast path: HGET the by-id hash, then ZREM + HDEL in a MULTI so the
   * two structures stay in sync. The MULTI also acts as the race
   * arbiter — only one concurrent caller will see a non-zero ZREM
   * result. Falls back to a zset scan if the hash misses (pre-deploy
   * in-flight entries).
   */
  async respond(ctx: TenantContext, taskId: string): Promise<RespondOutcome> {
    const redis = getSharedRedis();
    const inflightKey = this.config.keys.inflight(ctx);
    const hashKey = this.inflightHashKey(ctx);

    const raw = await redis.hget(hashKey, taskId);
    if (raw) {
      const result = await redis.multi()
        .zrem(inflightKey, raw)
        .hdel(hashKey, taskId)
        .exec();
      const removed = (result?.[0]?.[1] as number) ?? 0;
      return removed > 0 ? 'accepted' : 'already_completed';
    }
    return this.respondViaScan(ctx, taskId);
  }

  private async respondViaScan(
    ctx: TenantContext,
    taskId: string,
  ): Promise<RespondOutcome> {
    const redis = getSharedRedis();
    const inflightKey = this.config.keys.inflight(ctx);
    const raws = await redis.zrange(inflightKey, 0, -1);
    for (const raw of raws) {
      const entry = this.config.parseEntry(raw);
      if (entry?.taskId === taskId) {
        const removed = await redis.zrem(inflightKey, raw);
        return removed > 0 ? 'accepted' : 'already_completed';
      }
    }
    return 'task_not_found';
  }

  // ── Reclaim ────────────────────────────────────────────────────────────

  /**
   * Sweep expired in-flight entries for one (tenant, agent). Each
   * expired entry is either re-queued (bumping its reclaimCount) or
   * dead-lettered (when the count exceeds reclaimCeiling).
   * Idempotent — safe to call repeatedly.
   */
  async reclaim(ctx: TenantContext): Promise<{ redelivered: number; deadLettered: number }> {
    const redis = getSharedRedis();
    const now = Date.now();
    const inflightKey = this.config.keys.inflight(ctx);
    const hashKey = this.inflightHashKey(ctx);
    const listKey = this.config.keys.list(ctx);

    const raws = await redis.zrangebyscore(inflightKey, '-inf', now);
    let redelivered = 0;
    let deadLettered = 0;

    for (const raw of raws) {
      const entry = this.config.parseEntry(raw);
      if (!entry) {
        // Unparseable: just remove from the zset. There's no taskId to
        // key the hash by, so the hash entry (if any) will outlive
        // this sweep — but it'll be cleared the next time someone
        // pulls the same taskId, or it ages out with the agent's
        // `forget`. Logging is unhelpful here because the payload is
        // already malformed.
        await redis.zrem(inflightKey, raw);
        continue;
      }

      const nextAttempt = entry.reclaimCount + 1;
      if (nextAttempt >= this.config.reclaimCeiling) {
        // Atomic removal from inflight zset + by-id hash, then DLQ.
        await redis.pipeline()
          .zrem(inflightKey, raw)
          .hdel(hashKey, entry.taskId)
          .exec();
        const dl = this.config.buildDeadLetter({
          taskId: entry.taskId,
          inner: entry.inner,
          attemptCount: nextAttempt,
        });
        await writeDeadLetter(ctx, {
          taskId: entry.taskId,
          targetUrl: dl.targetUrl,
          taskResult: dl.taskResult,
          failureReason: dl.failureReason,
          httpStatus: 0,
          attemptCount: nextAttempt,
        });
        deadLettered += 1;
      } else {
        const updated: VisibilityEntry<T> = {
          taskId: entry.taskId,
          inner: entry.inner,
          reclaimCount: nextAttempt,
          ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
        };
        // ZREM old inflight + HDEL old hash + LPUSH back to the list,
        // all in one round-trip. The next pull() will repopulate the
        // hash when it re-claims this entry.
        await redis.pipeline()
          .zrem(inflightKey, raw)
          .hdel(hashKey, entry.taskId)
          .lpush(listKey, this.config.serializeEntry(updated))
          .exec();
        redelivered += 1;
      }
    }

    return { redelivered, deadLettered };
  }

  /**
   * Iterate every participant of this queue and reclaim per-(tenant,
   * agent). Called by the reclaim worker in agent-connector every
   * BROKER_RECLAIM_INTERVAL_MS.
   */
  async reclaimAll(): Promise<{ redelivered: number; deadLettered: number }> {
    const redis = getSharedRedis();
    const members = await redis.smembers(this.config.participantSet);
    let redelivered = 0;
    let deadLettered = 0;

    const contexts: TenantContext[] = [];
    for (const member of members) {
      const [tenantId, agentId] = member.split(':', 2);
      if (!tenantId || !agentId) continue;
      contexts.push({ tenantId, agentId });
    }

    // Chunked Promise.all: keeps the total in-flight Redis commands
    // bounded by RECLAIM_ALL_CHUNK while still parallelising across
    // (tenant, agent) members. Each chunk waits for the previous chunk
    // to settle before starting the next.
    for (let i = 0; i < contexts.length; i += RECLAIM_ALL_CHUNK) {
      const slice = contexts.slice(i, i + RECLAIM_ALL_CHUNK);
      const results = await Promise.all(slice.map(c => this.reclaim(c)));
      for (const r of results) {
        redelivered += r.redelivered;
        deadLettered += r.deadLettered;
      }
    }
    return { redelivered, deadLettered };
  }

  // ── Orphan recovery (crash-safety counterpart to BLMOVE in pull) ───────

  /**
   * Recover entries left in holding lists by processes whose heartbeat
   * has expired. For one (tenant, agent):
   *
   *   1. Iterate `processorsKey` — the set of process IDs that ever
   *      claimed an entry here.
   *   2. For each process ID, check if its heartbeat key exists.
   *      - If yes (alive or recently alive within the TTL window):
   *        skip — its holding list belongs to it.
   *      - If no (dead long enough that the sweep should act): LMOVE
   *        each holding-list entry back to the queue, then SREM the
   *        process from the registry. The malformed-entry case is
   *        treated the same way as inbox's reclaim drops it: pop and
   *        log, no DLQ (the payload is unidentifiable).
   *
   * Idempotent — safe to call repeatedly. The owning live process
   * never appears as a candidate because its own heartbeat is fresh.
   */
  async recoverOrphans(ctx: TenantContext): Promise<{ recovered: number; dropped: number }> {
    const redis = getSharedRedis();
    const procKey = this.processorsKey(ctx);
    const processors = await redis.smembers(procKey);
    let recovered = 0;
    let dropped = 0;

    for (const otherProcessId of processors) {
      // Never sweep our own holding list; pull() may have an entry
      // mid-flight in it right now.
      if (otherProcessId === PROCESS_ID) continue;

      const heartbeatExists = await redis.exists(heartbeatKeyFor(otherProcessId));
      if (heartbeatExists) continue;

      const holdingKey = this.holdingListKey(ctx, otherProcessId);
      // Drain the holding list one entry at a time. LMOVE (RIGHT→LEFT)
      // pops the oldest entry and pushes back onto the queue head;
      // a fresh pull() will see it in the next round.
      // Loop bounded by an empty-list null return to avoid infinite
      // iteration if some other process is somehow writing here (it
      // shouldn't — each holding list is owned by exactly one PROCESS_ID).
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Atomically: pop from holding, push to queue. If we crash
        // here the entry's on the queue (worst case: re-delivered).
        const payload = await redis.lmove(holdingKey, this.config.keys.list(ctx), 'RIGHT', 'LEFT');
        if (payload === null) break;
        const parsed = this.config.parseEntry(payload);
        if (parsed) {
          recovered += 1;
        } else {
          // Already moved to the queue but unparseable — let the next
          // pull() drop it via the existing malformed path. Count it
          // here so callers see the breakdown.
          dropped += 1;
          logger.warn(
            { ctx, processId: otherProcessId, label: this.config.logLabel },
            'visibility-queue: recovered malformed orphan; will drop on next pull',
          );
        }
      }

      // Holding list is empty and the owner is dead: deregister so the
      // sweep stops considering this process.
      await redis.pipeline()
        .srem(procKey, otherProcessId)
        .del(holdingKey)
        .exec();
    }

    return { recovered, dropped };
  }

  /**
   * Sweep orphans across every participant. Mirrors reclaimAll's
   * chunked-parallel iteration. Called by the reclaim worker on the
   * same interval as reclaimAll.
   */
  async recoverOrphansAll(): Promise<{ recovered: number; dropped: number }> {
    const redis = getSharedRedis();
    const members = await redis.smembers(this.config.participantSet);
    let recovered = 0;
    let dropped = 0;

    const contexts: TenantContext[] = [];
    for (const member of members) {
      const [tenantId, agentId] = member.split(':', 2);
      if (!tenantId || !agentId) continue;
      contexts.push({ tenantId, agentId });
    }

    for (let i = 0; i < contexts.length; i += RECLAIM_ALL_CHUNK) {
      const slice = contexts.slice(i, i + RECLAIM_ALL_CHUNK);
      const results = await Promise.all(slice.map(c => this.recoverOrphans(c)));
      for (const r of results) {
        recovered += r.recovered;
        dropped += r.dropped;
      }
    }
    return { recovered, dropped };
  }

  // ── Teardown ───────────────────────────────────────────────────────────

  /**
   * Remove all per-(tenant, agent) state for this queue: participant
   * membership, list, inflight, seq, by-id hash, processor registry,
   * and any holding lists registered for this ctx. Called on agent
   * deregistration. The DEL of every known holding list is best-effort
   * — if a different process is mid-pull here, its LREM will fail
   * silently after our DEL and the entry is just gone (acceptable
   * during a deregistration the operator just asked for).
   */
  async forget(ctx: TenantContext): Promise<void> {
    const redis = getSharedRedis();
    const processors = await redis.smembers(this.processorsKey(ctx));
    const pipe = redis.pipeline()
      .srem(this.config.participantSet, `${ctx.tenantId}:${ctx.agentId}`)
      .del(this.config.keys.list(ctx))
      .del(this.config.keys.inflight(ctx))
      .del(this.inflightHashKey(ctx))
      .del(this.config.keys.seq(ctx))
      .del(this.processorsKey(ctx));
    for (const procId of processors) {
      pipe.del(this.holdingListKey(ctx, procId));
    }
    await pipe.exec();
  }
}
