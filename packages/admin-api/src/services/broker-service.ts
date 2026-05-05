import type IORedis from 'ioredis';
import { TenantContext } from '@nova/shared';
import { getSharedRedis } from '@nova/shared';
import { BROKER_VISIBILITY_TIMEOUT_MS } from '@nova/shared';
import {
  inboxKey,
  inflightKey,
  isBrokerAgent,
} from '@nova/task-queue/src/inbox';
import {
  replyInboxKey,
  replyInflightKey,
} from '@nova/task-queue/src/reply-inbox';
import { listAllActiveAgents } from './agent-service';

export type BrokerMode = 'broker' | 'direct';

export interface QueueStats {
  /** Pending entries awaiting claim (Redis list length). */
  depth: number;
  /** Claimed entries awaiting ack (inflight sorted-set cardinality). */
  inflightCount: number;
  /**
   * Milliseconds since the oldest in-flight entry was claimed, or null when
   * inflight is empty. Derived from the visibility-expiry score minus the
   * configured timeout — a large value signals a stuck consumer.
   */
  oldestInflightAgeMs: number | null;
}

export interface BrokerStatus {
  mode: BrokerMode;
  /** Incoming task queue (broker agent pulls via nova_next_task). */
  inbox: QueueStats;
  /** Outgoing reply queue (sender pulls via nova_next_reply). */
  replyInbox: QueueStats;
}

export interface BrokerSummaryEntry extends BrokerStatus {
  tenantId: string;
  agentId: string;
  name: string;
}

async function queueStats(redis: IORedis, listKey: string, zsetKey: string): Promise<QueueStats> {
  const [depth, inflightCount, oldest] = await Promise.all([
    redis.llen(listKey),
    redis.zcard(zsetKey),
    redis.zrange(zsetKey, 0, 0, 'WITHSCORES'),
  ]);

  let oldestInflightAgeMs: number | null = null;
  if (oldest.length >= 2) {
    const visibleUntilMs = Number(oldest[1]);
    if (Number.isFinite(visibleUntilMs)) {
      const claimedAtMs = visibleUntilMs - BROKER_VISIBILITY_TIMEOUT_MS;
      oldestInflightAgeMs = Math.max(0, Date.now() - claimedAtMs);
    }
  }

  return { depth, inflightCount, oldestInflightAgeMs };
}

export async function getBrokerStatus(
  ctx: TenantContext,
  redis: IORedis = getSharedRedis(),
): Promise<BrokerStatus> {
  const broker = await isBrokerAgent(ctx);
  const [inbox, replyInbox] = await Promise.all([
    queueStats(redis, inboxKey(ctx), inflightKey(ctx)),
    queueStats(redis, replyInboxKey(ctx), replyInflightKey(ctx)),
  ]);
  return { mode: broker ? 'broker' : 'direct', inbox, replyInbox };
}

/**
 * Broker-mode summary across all active agents. Deregistered agents are
 * excluded (listAllActiveAgents already filters them); direct-mode agents are
 * also dropped so the summary shows only the population operators actually
 * care about here.
 */
export async function getBrokerSummary(
  redis: IORedis = getSharedRedis(),
): Promise<BrokerSummaryEntry[]> {
  const active = await listAllActiveAgents();
  const results: BrokerSummaryEntry[] = [];
  for (const agent of active) {
    const ctx: TenantContext = { tenantId: agent.tenantId, agentId: agent.agentId };
    if (!(await isBrokerAgent(ctx))) continue;
    const status = await getBrokerStatus(ctx, redis);
    results.push({ ...status, tenantId: agent.tenantId, agentId: agent.agentId, name: agent.name });
  }
  return results;
}
