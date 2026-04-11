import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { logger } from '@nova/shared/src/logger';
import { redisKey, queueName, TenantContext } from '@nova/shared/src/tenant';
import { QueuedTask } from '@nova/shared/src/types';

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
