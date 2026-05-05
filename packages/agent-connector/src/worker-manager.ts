import IORedis from 'ioredis';
import { Worker, Job } from 'bullmq';
import { queueName, TenantContext } from '@nova/shared';
import { getSharedRedis, REDIS_URL } from '@nova/shared';
import { logger } from '@nova/shared';
import {
  AGENT_LIFECYCLE_CHANNEL,
  AgentLifecycleEvent,
  listActiveAgentMeta,
} from '@nova/shared';

type TaskProcessor = (job: Job, ctx: TenantContext) => Promise<void>;

// "tenantId:agentId" → Worker[] (one per tier)
const workerMap = new Map<string, Worker[]>();

// Tier 0 is quarantined at the gate and never reaches the queue.
const ACTIVE_TIERS = [1, 2, 3];

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);

let lifecycleSub: IORedis | null = null;

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

  // Primary path: pipelined fetch of all active agents from the registry Set.
  const agents = await listActiveAgentMeta(redis);
  for (const agent of agents) {
    if (!agent.tenantId) continue;
    startWorkersForAgent({ tenantId: agent.tenantId, agentId: agent.agentId }, processTask);
  }
  let started = agents.length;

  // Legacy fallback: registry Set empty but agent-index keys linger from pre-migration state.
  // SCAN (not KEYS) + pipelined GET to avoid blocking Redis.
  if (started === 0) {
    const indexKeys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'nova:agent-index:*', 'COUNT', 100);
      indexKeys.push(...batch);
      cursor = next;
    } while (cursor !== '0');

    if (indexKeys.length > 0) {
      const pipe = redis.pipeline();
      for (const key of indexKeys) pipe.get(key);
      const results = await pipe.exec();
      results?.forEach(([err, tenantId], i) => {
        if (err || !tenantId) return;
        const agentId = indexKeys[i]!.slice('nova:agent-index:'.length);
        startWorkersForAgent({ tenantId: tenantId as string, agentId }, processTask);
        started++;
      });
    }
  }

  logger.info({ agentCount: started }, 'Worker manager initialized with existing agents');

  // Subscribe to lifecycle channel for dynamic worker management.
  // Pub/Sub requires a dedicated connection; tracked in module scope so shutdown can close it.
  lifecycleSub = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  await lifecycleSub.subscribe(AGENT_LIFECYCLE_CHANNEL);

  lifecycleSub.on('message', (_channel: string, message: string) => {
    try {
      const event: AgentLifecycleEvent = JSON.parse(message);
      handleLifecycleEvent(event, processTask);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to parse agent lifecycle event');
    }
  });

  lifecycleSub.on('error', (err) => {
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
  if (lifecycleSub) {
    await lifecycleSub.quit().catch(() => { /* already closed */ });
    lifecycleSub = null;
  }
  const all = Array.from(workerMap.values()).flat();
  await Promise.all(all.map(w => w.close()));
  workerMap.clear();
  logger.info('All workers shut down');
}
