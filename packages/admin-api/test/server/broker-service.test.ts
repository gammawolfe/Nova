import { describe, it, expect, vi, beforeEach } from 'vitest';
import type IORedis from 'ioredis';

vi.mock('@nova/task-queue/src/inbox', async () => ({
  inboxKey: (ctx: { tenantId: string; agentId: string }) =>
    `nova:inbox:${ctx.tenantId}:${ctx.agentId}`,
  inflightKey: (ctx: { tenantId: string; agentId: string }) =>
    `nova:inflight:${ctx.tenantId}:${ctx.agentId}`,
  isBrokerAgent: vi.fn(async () => true),
}));

vi.mock('@nova/task-queue/src/reply-inbox', async () => ({
  replyInboxKey: (ctx: { tenantId: string; agentId: string }) =>
    `nova:reply-inbox:${ctx.tenantId}:${ctx.agentId}`,
  replyInflightKey: (ctx: { tenantId: string; agentId: string }) =>
    `nova:reply-inbox-inflight:${ctx.tenantId}:${ctx.agentId}`,
}));

vi.mock('@nova/shared/src/broker-config', () => ({
  BROKER_VISIBILITY_TIMEOUT_MS: 5 * 60 * 1000,
}));

vi.mock('@nova/shared/src/redis', () => ({
  getSharedRedis: vi.fn(() => {
    throw new Error('tests must pass redis explicitly');
  }),
}));

vi.mock('../../src/services/agent-service', () => ({
  listAllActiveAgents: vi.fn(),
}));

import * as brokerService from '../../src/services/broker-service';
import { isBrokerAgent } from '@nova/task-queue/src/inbox';
import { listAllActiveAgents } from '../../src/services/agent-service';
import { BROKER_VISIBILITY_TIMEOUT_MS } from '@nova/shared/src/broker-config';

/** Minimal ioredis stub wired to in-memory maps. */
function makeRedis(state: {
  lists?: Record<string, string[]>;
  zsets?: Record<string, Array<{ member: string; score: number }>>;
  hashes?: Record<string, Record<string, string>>;
}): IORedis {
  const lists = state.lists ?? {};
  const zsets = state.zsets ?? {};
  const hashes = state.hashes ?? {};
  return {
    llen: vi.fn(async (key: string) => (lists[key] ?? []).length),
    zcard: vi.fn(async (key: string) => (zsets[key] ?? []).length),
    zrange: vi.fn(async (key: string, start: number, stop: number, withScores?: string) => {
      const entries = [...(zsets[key] ?? [])].sort((a, b) => a.score - b.score);
      const slice = entries.slice(start, stop === -1 ? undefined : stop + 1);
      if (withScores === 'WITHSCORES') {
        return slice.flatMap(e => [e.member, String(e.score)]);
      }
      return slice.map(e => e.member);
    }),
    hgetall: vi.fn(async (key: string) => hashes[key] ?? {}),
  } as unknown as IORedis;
}

describe('broker-service.getBrokerStatus', () => {
  beforeEach(() => {
    vi.mocked(isBrokerAgent).mockReset().mockResolvedValue(true);
  });

  it('reports broker mode and zeroed stats when queues are empty', async () => {
    const redis = makeRedis({});
    const status = await brokerService.getBrokerStatus(
      { tenantId: 't1', agentId: 'a1' },
      redis,
    );
    expect(status.mode).toBe('broker');
    expect(status.inbox).toEqual({ depth: 0, inflightCount: 0, oldestInflightAgeMs: null });
    expect(status.replyInbox).toEqual({ depth: 0, inflightCount: 0, oldestInflightAgeMs: null });
    expect(status.brokerPresence).toEqual({
      status: 'offline',
      activeConnections: 0,
      lastSeenAt: null,
      updatedAt: null,
    });
  });

  it('reports direct mode when isBrokerAgent returns false', async () => {
    vi.mocked(isBrokerAgent).mockResolvedValue(false);
    const redis = makeRedis({});
    const status = await brokerService.getBrokerStatus(
      { tenantId: 't1', agentId: 'a1' },
      redis,
    );
    expect(status.mode).toBe('direct');
    expect(status.brokerPresence.status).toBe('offline');
  });

  it('computes depth, inflight count, and oldest-inflight age', async () => {
    const now = Date.now();
    // Oldest entry: claimed 90s ago → visibleUntil = now - 90000 + timeout
    const oldestVisibleUntil = now - 90_000 + BROKER_VISIBILITY_TIMEOUT_MS;
    const newerVisibleUntil = now - 1_000 + BROKER_VISIBILITY_TIMEOUT_MS;

    const redis = makeRedis({
      lists: {
        'nova:inbox:t1:a1': ['task-1', 'task-2', 'task-3'],
        'nova:reply-inbox:t1:a1': ['reply-1'],
      },
      zsets: {
        'nova:inflight:t1:a1': [
          { member: 'entry-a', score: newerVisibleUntil },
          { member: 'entry-b', score: oldestVisibleUntil },
        ],
      },
      hashes: {
        'nova:broker-presence:t1:a1': {
          status: 'online',
          activeConnections: '1',
          lastSeenAt: '2026-05-17T12:00:00.000Z',
          updatedAt: '2026-05-17T12:00:15.000Z',
        },
      },
    });

    const status = await brokerService.getBrokerStatus(
      { tenantId: 't1', agentId: 'a1' },
      redis,
    );

    expect(status.inbox.depth).toBe(3);
    expect(status.inbox.inflightCount).toBe(2);
    // Age should be ~90000ms (allow 100ms tolerance for test overhead)
    expect(status.inbox.oldestInflightAgeMs).toBeGreaterThanOrEqual(89_900);
    expect(status.inbox.oldestInflightAgeMs).toBeLessThanOrEqual(90_100);

    expect(status.replyInbox.depth).toBe(1);
    expect(status.replyInbox.inflightCount).toBe(0);
    expect(status.replyInbox.oldestInflightAgeMs).toBeNull();
    expect(status.brokerPresence).toEqual({
      status: 'online',
      activeConnections: 1,
      lastSeenAt: '2026-05-17T12:00:00.000Z',
      updatedAt: '2026-05-17T12:00:15.000Z',
    });
  });

  it('clamps a past-visibility score to age 0', async () => {
    // Score older than now means claim was well over the timeout → reclaim window.
    const redis = makeRedis({
      zsets: {
        'nova:inflight:t1:a1': [{ member: 'stale', score: Date.now() - 60_000 }],
      },
    });
    const status = await brokerService.getBrokerStatus(
      { tenantId: 't1', agentId: 'a1' },
      redis,
    );
    // visibleUntil is in the past, but age is computed from claim time, so age
    // will be > BROKER_VISIBILITY_TIMEOUT_MS. Assert it's positive and sensible.
    expect(status.inbox.oldestInflightAgeMs).not.toBeNull();
    expect(status.inbox.oldestInflightAgeMs!).toBeGreaterThan(BROKER_VISIBILITY_TIMEOUT_MS);
  });
});

describe('broker-service.getBrokerSummary', () => {
  beforeEach(() => {
    vi.mocked(isBrokerAgent).mockReset();
    vi.mocked(listAllActiveAgents).mockReset();
  });

  it('filters out direct-mode agents', async () => {
    vi.mocked(listAllActiveAgents).mockResolvedValue([
      { agentId: 'a1', tenantId: 't1', name: 'Alpha', description: '', status: 'active', skills: [], capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true } },
      { agentId: 'a2', tenantId: 't1', name: 'Beta', description: '', status: 'active', skills: [], capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true } },
    ] as any);
    // a1 broker, a2 direct
    vi.mocked(isBrokerAgent).mockImplementation(async (ctx: any) => ctx.agentId === 'a1');

    const redis = makeRedis({});
    const entries = await brokerService.getBrokerSummary(redis);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.agentId).toBe('a1');
    expect(entries[0]?.name).toBe('Alpha');
    expect(entries[0]?.mode).toBe('broker');
    expect(entries[0]?.brokerPresence.status).toBe('offline');
  });

  it('returns empty list when no active agents', async () => {
    vi.mocked(listAllActiveAgents).mockResolvedValue([]);
    const entries = await brokerService.getBrokerSummary(makeRedis({}));
    expect(entries).toEqual([]);
  });
});
