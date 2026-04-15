import IORedis from 'ioredis';
import { Worker, Job } from 'bullmq';
import { queueName, TenantContext } from '@nova/shared/src/tenant';
import { getSharedRedis, REDIS_URL } from '@nova/shared/src/redis';
import { logger } from '@nova/shared/src/logger';
import {
  AGENT_REGISTRY_SET,
  AGENT_LIFECYCLE_CHANNEL,
  AgentLifecycleEvent,
  agentIndexKey,
  agentMetaKey,
} from '@nova/shared/src/agent-index';

type TaskProcessor = (job: Job, ctx: TenantContext) => Promise<void>;

// "tenantId:agentId" → Worker[] (one per tier)
const workerMap = new Map<string, Worker[]>();

// Tier 0 is quarantined at the gate and never reaches the queue.
const ACTIVE_TIERS = [1, 2, 3];

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);

function workerKey(ctx: TenantContext): string {
  return `${ctx.tenantId}:${ctx.agentId}`;
}

function startWorkersForAgent(ctx: TenantContext, processTask: TaskProcessor): void {
  const key = workerKey(ctx);
  if (workerMap.has(key)) return;

  const connection = getSharedRedis();
  const workers: Worker[] = [];

  for (const tier of ACTIVE_TIERS) {
    const qName = queueName(ctx, tier);
    const worker = new Worker(
      qName,
      async (job: Job) => processTask(job, ctx),
      { connection, concurrency: WORKER_CONCURRENCY }
    );

    worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, err, agentId: ctx.agentId }, 'Worker job failed');
    });

    workers.push(worker);
  }

  workerMap.set(key, workers);
  logger.info({ tenantId: ctx.tenantId, agentId: ctx.agentId, tiers: ACTIVE_TIERS }, 'Workers started for agent');
}

async function stopWorkersForAgent(ctx: TenantContext): Promise<void> {
  const key = workerKey(ctx);
  const workers = workerMap.get(key);
  if (!workers) return;

  await Promise.all(workers.map(w => w.close()));
  workerMap.delete(key);
  logger.info({ tenantId: ctx.tenantId, agentId: ctx.agentId }, 'Workers stopped for agent');
}

/**
 * Initialize the worker manager:
 * 1. Scan Redis for all registered agents and start workers for active ones
 * 2. Subscribe to lifecycle events for dynamic start/stop
 */
export async function initWorkerManager(processTask: TaskProcessor): Promise<void> {
  const redis = getSharedRedis();

  // Discover existing agents from the registry
  const agentIds = await redis.smembers(AGENT_REGISTRY_SET);
  let started = 0;

  for (const agentId of agentIds) {
    const meta = await redis.hgetall(agentMetaKey(agentId));
    if (!meta['status'] || meta['status'] !== 'active') continue;

    const tenantId = meta['tenantId'] || await redis.get(agentIndexKey(agentId));
    if (!tenantId) continue;

    startWorkersForAgent({ tenantId, agentId }, processTask);
    started++;
  }

  // Fallback: if registry is empty but the legacy agent-index keys exist,
  // start a worker for any agent we can find via SCAN
  if (started === 0) {
    const keys = await redis.keys('nova:agent-index:*');
    for (const key of keys) {
      const agentId = key.replace('nova:agent-index:', '');
      const tenantId = await redis.get(key);
      if (!tenantId) continue;
      startWorkersForAgent({ tenantId, agentId }, processTask);
      started++;
    }
  }

  logger.info({ agentCount: started }, 'Worker manager initialized with existing agents');

  // Subscribe to lifecycle channel for dynamic worker management
  // Pub/Sub requires a dedicated connection
  const sub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  await sub.subscribe(AGENT_LIFECYCLE_CHANNEL);

  sub.on('message', (_channel: string, message: string) => {
    try {
      const event: AgentLifecycleEvent = JSON.parse(message);
      handleLifecycleEvent(event, processTask);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to parse agent lifecycle event');
    }
  });

  sub.on('error', (err) => {
    logger.error({ err: err.message }, 'Lifecycle subscriber error');
  });
}

function handleLifecycleEvent(event: AgentLifecycleEvent, processTask: TaskProcessor): void {
  const ctx: TenantContext = { tenantId: event.tenantId, agentId: event.agentId };

  if (event.action === 'approved' || (event.action === 'created' && event.status === 'active')) {
    startWorkersForAgent(ctx, processTask);
  } else if (event.action === 'deregistered') {
    stopWorkersForAgent(ctx).catch(err =>
      logger.error({ err, agentId: event.agentId }, 'Failed to stop workers for deregistered agent')
    );
  }
}

/**
 * Gracefully shut down all active workers.
 */
export async function shutdownAllWorkers(): Promise<void> {
  const all = Array.from(workerMap.values()).flat();
  await Promise.all(all.map(w => w.close()));
  workerMap.clear();
  logger.info('All workers shut down');
}
