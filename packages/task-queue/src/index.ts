import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { redisKey, queueName, TenantContext } from '@nova/shared/src/tenant';
import { QueuedTask, TaskState, TaskResult } from '@nova/shared/src/types';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
export const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });

// Cache Queue instances per queue name to avoid per-request connection churn
const queueCache = new Map<string, Queue>();

function getOrCreateQueue(name: string): Queue {
  let queue = queueCache.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: redis });
    queueCache.set(name, queue);
  }
  return queue;
}

/**
 * Pushes a validated task onto the Redis BullMQ layer, strictly enforcing Idempotency
 * using Redis `SET NX` primitives.
 * @returns boolean `true` if queued, `false` if the idempotency lock prevented it.
 */
export async function enqueueWithIdempotency(
  ctx: TenantContext,
  task: QueuedTask,
  ttlSeconds: number
): Promise<boolean> {
  // Map idempotency key isolating bounds
  const idempotencyKey = redisKey(ctx, 'idempotency', task.taskId);

  // SET NX ensures atomicity — if key exists, we immediately drop request
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
      attempts: 1 // Idempotent resubmission by HTTP sender is our retry heuristic
    });

    logger.info({ ctx, queue: targetedQueueName }, 'Pushed task onto target Tier queue');
    return true;
  } catch (err) {
    // Drop the lock if BullMQ queuing mechanically fails
    await redis.del(idempotencyKey);
    throw err;
  }
}

// --- Task State Persistence ---

const TASK_TTL_SECONDS = 60 * 60 * 24; // 24 hours

/**
 * Persist the full initial task state as a Redis hash.
 */
export async function setTaskState(
  ctx: TenantContext,
  state: TaskState
): Promise<void> {
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

  await redis.hset(key, flat);
  await redis.expire(key, TASK_TTL_SECONDS);
}

/**
 * Retrieve task state from Redis. Returns null if not found.
 */
export async function getTaskState(
  ctx: TenantContext,
  taskId: string
): Promise<TaskState | null> {
  const key = redisKey(ctx, 'task', taskId);
  const raw = await redis.hgetall(key);

  if (!raw || Object.keys(raw).length === 0 || !raw['taskId']) return null;

  // Cast is safe — we only write well-formed hashes via setTaskState/updateTaskStatus
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

// --- SSE Event Publishing ---

/**
 * Append an event to the Redis sorted set (for replay) and publish to pub/sub (for live SSE).
 * The sorted set is scored by event ID and keyed by redisKey(ctx, 'task-events-log', taskId).
 * The pub/sub channel is keyed by redisKey(ctx, 'task-events', taskId).
 */
export async function publishTaskEvent(
  ctx: TenantContext,
  taskId: string,
  event: { type: string; data: unknown }
): Promise<void> {
  const logKey = redisKey(ctx, 'task-events-log', taskId);
  const channelKey = redisKey(ctx, 'task-events', taskId);

  // Get next event ID using INCR for monotonically increasing IDs
  const eventIdKey = redisKey(ctx, 'task-events-seq', taskId);
  const eventId = await redis.incr(eventIdKey);
  await redis.expire(eventIdKey, TASK_TTL_SECONDS);

  const payload = JSON.stringify({ id: eventId, type: event.type, data: event.data });

  // Append to sorted set for replay (scored by eventId)
  await redis.zadd(logKey, eventId, payload);
  await redis.expire(logKey, TASK_TTL_SECONDS);

  // Publish to channel for live SSE consumers
  await redis.publish(channelKey, payload);
}

// --- Task Status Updates ---

/**
 * Partial update of task status and optional extra fields.
 */
export async function updateTaskStatus(
  ctx: TenantContext,
  taskId: string,
  status: TaskState['status'],
  extra?: { result?: TaskResult; statusMessage?: string }
): Promise<void> {
  const key = redisKey(ctx, 'task', taskId);

  const updates: Record<string, string> = {
    status,
    updatedAt: new Date().toISOString(),
  };

  if (extra?.result) updates.result = JSON.stringify(extra.result);
  if (extra?.statusMessage) updates.statusMessage = extra.statusMessage;

  await redis.hset(key, updates);
}
