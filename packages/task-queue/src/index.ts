import { Queue } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { redisKey, queueName, TenantContext } from '@nova/shared/src/tenant';
import { QueuedTask, TaskState, TaskResult } from '@nova/shared/src/types';
import { getSharedRedis } from '@nova/shared/src/redis';
import { BROKER_TASK_STATE_TTL_SECONDS } from '@nova/shared/src/broker-config';

// Cache Queue instances per queue name to avoid per-request connection churn.
// BullMQ Queues own a connection internally so we want at most one per name.
const queueCache = new Map<string, Queue>();

function getOrCreateQueue(name: string): Queue {
  let queue = queueCache.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: getSharedRedis() });
    queueCache.set(name, queue);
  }
  return queue;
}

/**
 * Pushes a validated task onto the Redis BullMQ layer, strictly enforcing
 * idempotency using Redis `SET NX` primitives.
 *
 * @returns boolean `true` if queued, `false` if the idempotency lock prevented it.
 */
export async function enqueueWithIdempotency(
  ctx: TenantContext,
  task: QueuedTask,
  ttlSeconds: number,
): Promise<boolean> {
  const redis = getSharedRedis();
  const idempotencyKey = redisKey(ctx, 'idempotency', task.taskId);

  // SET NX ensures atomicity — if the key exists, drop the request.
  const acquired = await redis.set(idempotencyKey, 'queued', 'EX', ttlSeconds, 'NX');
  if (!acquired) {
    logger.warn({ ctx, taskId: task.taskId }, 'Idempotent task drop detected');
    return false;
  }

  const targetedQueueName = queueName(ctx, task.tier);
  const queue = getOrCreateQueue(targetedQueueName);

  try {
    await queue.add('agent-task', task, {
      jobId: task.taskId,
      removeOnComplete: 100,
      removeOnFail: 1000,
      attempts: 1, // Idempotent resubmission by HTTP sender is our retry heuristic
    });

    logger.info({ ctx, queue: targetedQueueName }, 'Pushed task onto target Tier queue');
    return true;
  } catch (err) {
    // Drop the lock if BullMQ queuing mechanically fails
    await redis.del(idempotencyKey);
    throw err;
  }
}

// ── Task state persistence ─────────────────────────────────────────────────

/**
 * Persist the full initial task state as a Redis hash. Lifetime bounded by
 * BROKER_TASK_STATE_TTL_SECONDS (default 24h) so historical task records
 * don't accumulate forever in Redis.
 */
export async function setTaskState(ctx: TenantContext, state: TaskState): Promise<void> {
  const redis = getSharedRedis();
  const key = redisKey(ctx, 'task', state.taskId);

  const flat: Record<string, string> = {
    taskId: state.taskId,
    tenantId: state.tenantId,
    agentId: state.agentId,
    status: state.status,
    intent: state.intent,
    submittedAt: state.submittedAt,
    updatedAt: state.updatedAt,
    expiresAt: state.expiresAt,
    submitterDid: state.submitterDid,
  };

  if (state.result) flat.result = JSON.stringify(state.result);
  if (state.statusMessage) flat.statusMessage = state.statusMessage;
  if (state.estimatedResponseBy) flat.estimatedResponseBy = state.estimatedResponseBy;

  await redis.pipeline().hset(key, flat).expire(key, BROKER_TASK_STATE_TTL_SECONDS).exec();
}

/** Retrieve task state from Redis. Returns null if not found. */
export async function getTaskState(ctx: TenantContext, taskId: string): Promise<TaskState | null> {
  const redis = getSharedRedis();
  const key = redisKey(ctx, 'task', taskId);
  const raw = await redis.hgetall(key);

  if (!raw || Object.keys(raw).length === 0 || !raw['taskId']) return null;

  // Cast is safe — we only write well-formed hashes via setTaskState / updateTaskStatus.
  const r = raw as Record<string, string>;

  const state: TaskState = {
    taskId: r['taskId']!,
    tenantId: r['tenantId']!,
    agentId: r['agentId']!,
    status: r['status']! as TaskState['status'],
    intent: r['intent']!,
    submittedAt: r['submittedAt']!,
    updatedAt: r['updatedAt']!,
    expiresAt: r['expiresAt']!,
    submitterDid: r['submitterDid']!,
  };

  if (r['result']) state.result = JSON.parse(r['result']) as TaskResult;
  if (r['statusMessage']) state.statusMessage = r['statusMessage'];
  if (r['estimatedResponseBy']) state.estimatedResponseBy = r['estimatedResponseBy'];

  return state;
}

// ── SSE event publishing ───────────────────────────────────────────────────

/**
 * Append a task-event to the Redis sorted set (for replay) AND publish to
 * pub/sub (for live SSE). The sorted set is keyed by event ID; the channel
 * is the pub/sub channel for live subscribers.
 */
export async function publishTaskEvent(
  ctx: TenantContext,
  taskId: string,
  event: { type: string; data: unknown },
): Promise<void> {
  const redis = getSharedRedis();
  const logKey = redisKey(ctx, 'task-events-log', taskId);
  const channelKey = redisKey(ctx, 'task-events', taskId);
  const eventIdKey = redisKey(ctx, 'task-events-seq', taskId);

  const eventId = await redis.incr(eventIdKey);
  const payload = JSON.stringify({ id: eventId, type: event.type, data: event.data });

  // Pipeline: expire seq key, append to sorted set, expire log, publish —
  // single round-trip. The TTL matches the task-state hash so an event
  // never outlives the task it belongs to.
  await redis.pipeline()
    .expire(eventIdKey, BROKER_TASK_STATE_TTL_SECONDS)
    .zadd(logKey, eventId, payload)
    .expire(logKey, BROKER_TASK_STATE_TTL_SECONDS)
    .publish(channelKey, payload)
    .exec();
}

// ── Task status updates ────────────────────────────────────────────────────

/** Partial update of task status and optional extra fields. */
export async function updateTaskStatus(
  ctx: TenantContext,
  taskId: string,
  status: TaskState['status'],
  extra?: { result?: TaskResult; statusMessage?: string },
): Promise<void> {
  const redis = getSharedRedis();
  const key = redisKey(ctx, 'task', taskId);

  const updates: Record<string, string> = {
    status,
    updatedAt: new Date().toISOString(),
  };

  if (extra?.result) updates.result = JSON.stringify(extra.result);
  if (extra?.statusMessage) updates.statusMessage = extra.statusMessage;

  await redis.hset(key, updates);
}

export * from './inbox';
