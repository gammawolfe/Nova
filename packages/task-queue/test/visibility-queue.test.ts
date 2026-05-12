// packages/task-queue/test/visibility-queue.test.ts
//
// Unit tests for the generic VisibilityQueue extracted from inbox.ts /
// reply-inbox.ts. Uses an in-memory ioredis stub so the lifecycle
// (enqueue → list → pull → respond, plus reclaim and forget) can be
// driven without standing up a real Redis.
//
// These tests are deliberately exhaustive: VisibilityQueue is now the
// single source of truth for both inbox and reply-inbox semantics, so a
// regression here breaks both callers at once. Specific consumer
// behaviours (inbox's TTL filter, reply-inbox's setex pipeline op) are
// covered separately as part of the consumer-specific test files where
// those callbacks live.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: pin redis stub + dead-letter spy ahead of imports.
const { redisStub, fakeRedis, dlqWrites } = vi.hoisted(() => {
  interface StreamEntry { id: string; fields: string[] }
  interface SortedEntry { score: number; member: string }

  const state = {
    lists: new Map<string, string[]>(),         // LPUSH/BLPOP target
    sortedSets: new Map<string, SortedEntry[]>(),
    sets: new Map<string, Set<string>>(),
    hashes: new Map<string, Map<string, string>>(),
    counters: new Map<string, number>(),
    publishes: [] as Array<{ channel: string; payload: string }>,
    expires: [] as Array<{ key: string; ttl: number }>,
  };

  // A chainable pipeline emulation. Each operation captures a thunk
  // that returns its per-op result (matches ioredis exec() return shape:
  // Array<[Error | null, unknown]>). multi() and pipeline() share the
  // same builder — Redis-side atomicity doesn't show up in an in-memory
  // stub.
  function pipelineBuilder(): any {
    const ops: Array<() => unknown> = [];
    const self: any = {
      expire(key: string, ttl: number) {
        ops.push(() => { state.expires.push({ key, ttl }); return 1; });
        return self;
      },
      lpush(key: string, value: string) {
        ops.push(() => {
          const arr = state.lists.get(key) ?? [];
          arr.unshift(value);
          state.lists.set(key, arr);
          return arr.length;
        });
        return self;
      },
      sadd(key: string, member: string) {
        ops.push(() => {
          const s = state.sets.get(key) ?? new Set();
          const added = s.has(member) ? 0 : 1;
          s.add(member);
          state.sets.set(key, s);
          return added;
        });
        return self;
      },
      srem(key: string, member: string) {
        ops.push(() => {
          const had = state.sets.get(key)?.delete(member);
          return had ? 1 : 0;
        });
        return self;
      },
      del(key: string) {
        ops.push(() => {
          let removed = 0;
          if (state.lists.delete(key)) removed++;
          if (state.sortedSets.delete(key)) removed++;
          if (state.sets.delete(key)) removed++;
          if (state.hashes.delete(key)) removed++;
          if (state.counters.delete(key)) removed++;
          return removed > 0 ? 1 : 0;
        });
        return self;
      },
      publish(channel: string, payload: string) {
        ops.push(() => { state.publishes.push({ channel, payload }); return 0; });
        return self;
      },
      setex(key: string, _ttl: number, value: string) {
        ops.push(() => {
          // Stored as a list-with-one-entry to keep the stub small.
          state.lists.set(key, [value]);
          return 'OK';
        });
        return self;
      },
      zadd(key: string, score: number, member: string) {
        ops.push(() => {
          const arr = state.sortedSets.get(key) ?? [];
          arr.push({ score, member });
          state.sortedSets.set(key, arr);
          return 1;
        });
        return self;
      },
      zrem(key: string, member: string) {
        ops.push(() => {
          const arr = state.sortedSets.get(key) ?? [];
          const before = arr.length;
          const filtered = arr.filter(e => e.member !== member);
          state.sortedSets.set(key, filtered);
          return before - filtered.length;
        });
        return self;
      },
      hset(key: string, field: string, value: string) {
        ops.push(() => {
          const h = state.hashes.get(key) ?? new Map();
          const added = h.has(field) ? 0 : 1;
          h.set(field, value);
          state.hashes.set(key, h);
          return added;
        });
        return self;
      },
      hdel(key: string, field: string) {
        ops.push(() => {
          const h = state.hashes.get(key);
          if (!h) return 0;
          return h.delete(field) ? 1 : 0;
        });
        return self;
      },
      async exec() {
        return ops.map(op => [null, op()]);
      },
    };
    return self;
  }

  const fakeRedis: any = {
    state,
    async incr(key: string) {
      const v = (state.counters.get(key) ?? 0) + 1;
      state.counters.set(key, v);
      return v;
    },
    async expire(key: string, ttl: number) {
      state.expires.push({ key, ttl });
      return 1;
    },
    async lpush(key: string, value: string) {
      const arr = state.lists.get(key) ?? [];
      arr.unshift(value);
      state.lists.set(key, arr);
      return arr.length;
    },
    async lrange(key: string, _start: number, _stop: number) {
      // Implementation only needs full-range support for the cases tested.
      return [...(state.lists.get(key) ?? [])];
    },
    async blpop(key: string, _waitSec: number) {
      // Simulate non-blocking pop — return null if empty.
      const arr = state.lists.get(key) ?? [];
      if (arr.length === 0) return null;
      // BLPOP pops from the tail of an LPUSH'd list.
      const v = arr.pop()!;
      return [key, v];
    },
    async zadd(key: string, score: number, member: string) {
      const arr = state.sortedSets.get(key) ?? [];
      arr.push({ score, member });
      state.sortedSets.set(key, arr);
      return 1;
    },
    async zrange(key: string, _start: number, _stop: number) {
      return (state.sortedSets.get(key) ?? []).map(e => e.member);
    },
    async zrangebyscore(key: string, _min: string, max: number) {
      return (state.sortedSets.get(key) ?? [])
        .filter(e => e.score <= max)
        .map(e => e.member);
    },
    async zrem(key: string, member: string) {
      const arr = state.sortedSets.get(key) ?? [];
      const before = arr.length;
      const filtered = arr.filter(e => e.member !== member);
      state.sortedSets.set(key, filtered);
      return before - filtered.length;
    },
    async smembers(key: string) {
      return Array.from(state.sets.get(key) ?? []);
    },
    async hget(key: string, field: string) {
      return state.hashes.get(key)?.get(field) ?? null;
    },
    async hset(key: string, field: string, value: string) {
      const h = state.hashes.get(key) ?? new Map();
      const added = h.has(field) ? 0 : 1;
      h.set(field, value);
      state.hashes.set(key, h);
      return added;
    },
    async hdel(key: string, field: string) {
      const h = state.hashes.get(key);
      if (!h) return 0;
      return h.delete(field) ? 1 : 0;
    },
    pipeline() { return pipelineBuilder(); },
    multi() { return pipelineBuilder(); },
  };

  const dlqWrites: Array<unknown> = [];
  return { redisStub: fakeRedis, fakeRedis, dlqWrites };
});

vi.mock('@nova/shared/src/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

vi.mock('@nova/shared/src/redis', () => ({
  REDIS_URL: 'redis://stub',
  getSharedRedis: () => fakeRedis,
  closeSharedRedis: async () => {},
}));

vi.mock('../src/dead-letter', () => ({
  writeDeadLetter: vi.fn(async (ctx, params) => {
    dlqWrites.push({ ctx, ...params });
    return 'dlq-id';
  }),
}));

import { VisibilityQueue, KeyBuilder } from '../src/visibility-queue';

// ── Test-only inbox-style consumer ──────────────────────────────────────────

interface FakeTask {
  taskId: string;
  payload: string;
}

interface FakeNotification {
  seq: number;
  taskId: string;
  enqueuedAt: string;
}

const keys: KeyBuilder = {
  list: (ctx) => `test:list:${ctx.tenantId}:${ctx.agentId}`,
  inflight: (ctx) => `test:inflight:${ctx.tenantId}:${ctx.agentId}`,
  notifyChannel: (ctx) => `test:notify:${ctx.tenantId}:${ctx.agentId}`,
  seq: (ctx) => `test:seq:${ctx.tenantId}:${ctx.agentId}`,
};

function makeQueue() {
  return new VisibilityQueue<FakeTask, FakeNotification>({
    keys,
    participantSet: 'test:participants',
    visibilityTimeoutMs: 5_000,
    seqTtlSeconds: 60,
    reclaimCeiling: 3,
    logLabel: 'test-queue',
    buildNotification: ({ seq, taskId }) => ({ seq, taskId, enqueuedAt: new Date().toISOString() }),
    serializeEntry: (entry) => JSON.stringify({
      taskId: entry.taskId,
      payload: entry.inner,
      reclaimCount: entry.reclaimCount,
      ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
    }),
    parseEntry: (raw) => {
      try {
        const e = JSON.parse(raw);
        if (!e?.taskId || !e?.payload) return null;
        return {
          taskId: e.taskId,
          inner: e.payload as FakeTask,
          reclaimCount: typeof e.reclaimCount === 'number' ? e.reclaimCount : 0,
          seq: typeof e.seq === 'number' ? e.seq : undefined,
        };
      } catch { return null; }
    },
    buildDeadLetter: ({ taskId }) => ({
      targetUrl: 'test',
      failureReason: 'broker_no_response',
      taskResult: {
        type: 'TaskResult',
        requestId: taskId,
        status: 'error',
        error: { code: 'TEST_DLQ', message: 'reclaim ceiling', retryable: false },
        auditToken: 'none',
        completedAt: new Date().toISOString(),
        schemaVersion: '1.0',
      },
    }),
  });
}

const ctx = { tenantId: 't1', agentId: 'a1' };
const task: FakeTask = { taskId: 'task-1', payload: 'hello' };

beforeEach(() => {
  redisStub.state.lists.clear();
  redisStub.state.sortedSets.clear();
  redisStub.state.sets.clear();
  redisStub.state.hashes.clear();
  redisStub.state.counters.clear();
  redisStub.state.publishes.length = 0;
  redisStub.state.expires.length = 0;
  dlqWrites.length = 0;
});

function inflightHashKeyFor(c: { tenantId: string; agentId: string }) {
  return `${keys.inflight(c)}:by-id`;
}

describe('VisibilityQueue.enqueue', () => {
  it('writes the entry to the list and publishes a notification', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, task.taskId, task);

    const listKey = keys.list(ctx);
    expect(redisStub.state.lists.get(listKey)?.length).toBe(1);

    const entry = JSON.parse(redisStub.state.lists.get(listKey)![0]!);
    expect(entry.taskId).toBe('task-1');
    expect(entry.payload).toEqual(task);
    expect(entry.reclaimCount).toBe(0);
    expect(entry.seq).toBe(1);

    expect(redisStub.state.publishes).toHaveLength(1);
    expect(redisStub.state.publishes[0]!.channel).toBe(keys.notifyChannel(ctx));
    const notif = JSON.parse(redisStub.state.publishes[0]!.payload);
    expect(notif.seq).toBe(1);
    expect(notif.taskId).toBe('task-1');
  });

  it('registers the (tenant, agent) in the participant set', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, task.taskId, task);
    expect(redisStub.state.sets.get('test:participants')?.has('t1:a1')).toBe(true);
  });

  it('increments seq across enqueues', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, 't1', task);
    await q.enqueue(ctx, 't2', task);
    await q.enqueue(ctx, 't3', task);
    const arr = redisStub.state.lists.get(keys.list(ctx))!;
    const seqs = arr.map(e => JSON.parse(e).seq).sort();
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe('VisibilityQueue.pull', () => {
  it('returns null on empty queue', async () => {
    const q = makeQueue();
    const r = await q.pull(ctx, 0);
    expect(r).toBeNull();
  });

  it('pops the oldest entry (LPUSH head, BLPOP tail) and claims into inflight', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, 'a', { taskId: 'a', payload: 'first' });
    await q.enqueue(ctx, 'b', { taskId: 'b', payload: 'second' });

    const r = await q.pull(ctx, 0);
    expect(r).not.toBeNull();
    expect(r!.taskId).toBe('a'); // FIFO

    // 'a' moved to inflight, 'b' still in list.
    expect(redisStub.state.lists.get(keys.list(ctx))?.length).toBe(1);
    expect(redisStub.state.sortedSets.get(keys.inflight(ctx))?.length).toBe(1);
    expect(r!.visibleUntil).toBeInstanceOf(Date);
  });

  it('populates the by-id hash atomically with the inflight zset', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, 'tid', { taskId: 'tid', payload: 'p' });
    await q.pull(ctx, 0);

    const hashEntry = redisStub.state.hashes.get(inflightHashKeyFor(ctx))?.get('tid');
    expect(hashEntry).toBeDefined();

    const zsetEntry = redisStub.state.sortedSets.get(keys.inflight(ctx))![0]!.member;
    // Both structures hold the identical serialised entry so respond()'s
    // ZREM-by-raw-payload always matches the HGET-derived raw payload.
    expect(hashEntry).toBe(zsetEntry);
  });

  it('preserves reclaimCount and seq when claiming', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, 'x', { taskId: 'x', payload: 'xx' });
    const r = await q.pull(ctx, 0);
    expect(r!.reclaimCount).toBe(0);

    const inflightRaw = redisStub.state.sortedSets.get(keys.inflight(ctx))![0]!.member;
    const inflight = JSON.parse(inflightRaw);
    expect(inflight.taskId).toBe('x');
    expect(inflight.seq).toBe(1);
    expect(inflight.reclaimCount).toBe(0);
  });

  it('honours pullFilter and drops without claiming', async () => {
    const q = new VisibilityQueue<FakeTask, FakeNotification>({
      keys,
      participantSet: 'test:participants',
      visibilityTimeoutMs: 5_000,
      seqTtlSeconds: 60,
      reclaimCeiling: 3,
      logLabel: 'test-filter',
      buildNotification: ({ seq, taskId }) => ({ seq, taskId, enqueuedAt: '' }),
      serializeEntry: (e) => JSON.stringify({ taskId: e.taskId, payload: e.inner, reclaimCount: e.reclaimCount, seq: e.seq }),
      parseEntry: (raw) => {
        try { const e = JSON.parse(raw); return { taskId: e.taskId, inner: e.payload, reclaimCount: e.reclaimCount, seq: e.seq }; } catch { return null; }
      },
      buildDeadLetter: () => ({ targetUrl: 'test', failureReason: 'broker_no_response', taskResult: {} as any }),
      pullFilter: ({ entry }) => entry.taskId !== 'reject-me',
    });
    await q.enqueue(ctx, 'reject-me', { taskId: 'reject-me', payload: 'p' });
    const r = await q.pull(ctx, 0);
    expect(r).toBeNull();
    // Filtered: not claimed into inflight, not requeued.
    expect(redisStub.state.sortedSets.get(keys.inflight(ctx))?.length ?? 0).toBe(0);
  });

  it('returns null and logs when payload parsing fails', async () => {
    const q = makeQueue();
    redisStub.state.lists.set(keys.list(ctx), ['{not json']);
    const r = await q.pull(ctx, 0);
    expect(r).toBeNull();
  });
});

describe('VisibilityQueue.list', () => {
  it('returns all entries newest-first without removing them', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, 'a', { taskId: 'a', payload: '1' });
    await q.enqueue(ctx, 'b', { taskId: 'b', payload: '2' });

    const entries = await q.list(ctx);
    expect(entries.map(e => e.taskId)).toEqual(['b', 'a']); // LPUSH newest-first
    expect(redisStub.state.lists.get(keys.list(ctx))?.length).toBe(2);
  });
});

describe('VisibilityQueue.respond + peekInflight', () => {
  it('finds and removes an in-flight entry by taskId', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, 'x', { taskId: 'x', payload: 'p' });
    await q.pull(ctx, 0);

    const peeked = await q.peekInflight(ctx, 'x');
    expect(peeked).not.toBeNull();
    expect(peeked!.taskId).toBe('x');

    const outcome = await q.respond(ctx, 'x');
    expect(outcome).toBe('accepted');
    expect(redisStub.state.sortedSets.get(keys.inflight(ctx))?.length).toBe(0);
    // Hash entry is removed in the same MULTI as the zset entry.
    expect(redisStub.state.hashes.get(inflightHashKeyFor(ctx))?.has('x') ?? false).toBe(false);
  });

  it('returns task_not_found when the taskId is not in-flight', async () => {
    const q = makeQueue();
    const outcome = await q.respond(ctx, 'never-existed');
    expect(outcome).toBe('task_not_found');
  });

  it('respond falls back to zset scan for pre-deploy entries missing from the hash', async () => {
    const q = makeQueue();
    // Simulate a pre-hash deploy: entry lives in the zset only.
    const raw = JSON.stringify({ taskId: 'legacy', payload: { taskId: 'legacy', payload: 'p' }, reclaimCount: 0, seq: 1 });
    redisStub.state.sortedSets.set(keys.inflight(ctx), [{ score: Date.now() + 60_000, member: raw }]);

    const outcome = await q.respond(ctx, 'legacy');
    expect(outcome).toBe('accepted');
    expect(redisStub.state.sortedSets.get(keys.inflight(ctx))?.length).toBe(0);
  });

  it('peekInflight falls back to zset scan for pre-deploy entries missing from the hash', async () => {
    const q = makeQueue();
    const raw = JSON.stringify({ taskId: 'legacy', payload: { taskId: 'legacy', payload: 'p' }, reclaimCount: 0, seq: 1 });
    redisStub.state.sortedSets.set(keys.inflight(ctx), [{ score: Date.now() + 60_000, member: raw }]);

    const peeked = await q.peekInflight(ctx, 'legacy');
    expect(peeked).not.toBeNull();
    expect(peeked!.taskId).toBe('legacy');
  });
});

describe('VisibilityQueue.reclaim', () => {
  it('redelivers expired entries below the reclaim ceiling', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, 'x', { taskId: 'x', payload: 'p' });
    await q.pull(ctx, 0);

    // Force visibility expiry by setting the score in the past.
    const inflightKey = keys.inflight(ctx);
    const arr = redisStub.state.sortedSets.get(inflightKey)!;
    arr[0]!.score = Date.now() - 1_000;

    const r = await q.reclaim(ctx);
    expect(r.redelivered).toBe(1);
    expect(r.deadLettered).toBe(0);

    // Back on the list with reclaimCount incremented.
    const listed = await q.list(ctx);
    expect(listed[0]!.reclaimCount).toBe(1);
    expect(dlqWrites).toHaveLength(0);
    // Hash entry for the redelivered task is cleared — the next pull
    // will repopulate it.
    expect(redisStub.state.hashes.get(inflightHashKeyFor(ctx))?.has('x') ?? false).toBe(false);
  });

  it('writes to DLQ when reclaimCount hits the ceiling', async () => {
    const q = makeQueue();
    // Manually inject an entry already at reclaimCount = 2 (ceiling - 1).
    const entry = JSON.stringify({ taskId: 'doomed', payload: { taskId: 'doomed', payload: 'p' }, reclaimCount: 2, seq: 1 });
    redisStub.state.sortedSets.set(keys.inflight(ctx), [{ score: Date.now() - 1_000, member: entry }]);
    redisStub.state.hashes.set(inflightHashKeyFor(ctx), new Map([['doomed', entry]]));

    const r = await q.reclaim(ctx);
    expect(r.redelivered).toBe(0);
    expect(r.deadLettered).toBe(1);
    expect(dlqWrites).toHaveLength(1);
    expect((dlqWrites[0] as any).taskId).toBe('doomed');
    expect((dlqWrites[0] as any).failureReason).toBe('broker_no_response');
    expect((dlqWrites[0] as any).attemptCount).toBe(3);
    // DLQ path also clears the by-id hash.
    expect(redisStub.state.hashes.get(inflightHashKeyFor(ctx))?.has('doomed') ?? false).toBe(false);
  });

  it('drops unparseable inflight entries without DLQing them', async () => {
    const q = makeQueue();
    redisStub.state.sortedSets.set(keys.inflight(ctx), [
      { score: Date.now() - 1_000, member: '{garbage' },
    ]);
    const r = await q.reclaim(ctx);
    expect(r.redelivered).toBe(0);
    expect(r.deadLettered).toBe(0);
    expect(redisStub.state.sortedSets.get(keys.inflight(ctx))?.length).toBe(0);
  });

  it('reclaimAll iterates all (tenant, agent) members of the participant set', async () => {
    const q = makeQueue();
    await q.enqueue({ tenantId: 't1', agentId: 'a1' }, 'x', { taskId: 'x', payload: 'p' });
    await q.enqueue({ tenantId: 't2', agentId: 'a2' }, 'y', { taskId: 'y', payload: 'p' });
    await q.pull({ tenantId: 't1', agentId: 'a1' }, 0);
    await q.pull({ tenantId: 't2', agentId: 'a2' }, 0);

    // Both expire.
    for (const key of redisStub.state.sortedSets.keys()) {
      const arr = redisStub.state.sortedSets.get(key)!;
      for (const e of arr) e.score = Date.now() - 1_000;
    }

    const r = await q.reclaimAll();
    expect(r.redelivered).toBe(2);
  });
});

describe('VisibilityQueue.forget', () => {
  it('removes participant + list + inflight + by-id hash + seq for the (tenant, agent)', async () => {
    const q = makeQueue();
    await q.enqueue(ctx, 'x', { taskId: 'x', payload: 'p' });
    await q.pull(ctx, 0);

    await q.forget(ctx);
    expect(redisStub.state.lists.get(keys.list(ctx))).toBeUndefined();
    expect(redisStub.state.sortedSets.get(keys.inflight(ctx))).toBeUndefined();
    expect(redisStub.state.hashes.get(inflightHashKeyFor(ctx))).toBeUndefined();
    expect(redisStub.state.sets.get('test:participants')?.has('t1:a1') ?? false).toBe(false);
    expect(redisStub.state.counters.get(keys.seq(ctx))).toBeUndefined();
  });
});

describe('VisibilityQueue.reclaimAll chunking', () => {
  it('reclaims across many participants without falling over', async () => {
    const q = makeQueue();
    // 40 participants > the internal RECLAIM_ALL_CHUNK (16), so we cross
    // chunk boundaries. Each one has one expired in-flight entry.
    const N = 40;
    for (let i = 0; i < N; i++) {
      const c = { tenantId: `t${i}`, agentId: `a${i}` };
      await q.enqueue(c, `tid${i}`, { taskId: `tid${i}`, payload: 'p' });
      await q.pull(c, 0);
    }
    for (const key of redisStub.state.sortedSets.keys()) {
      for (const e of redisStub.state.sortedSets.get(key)!) e.score = Date.now() - 1_000;
    }

    const r = await q.reclaimAll();
    expect(r.redelivered).toBe(N);
    expect(r.deadLettered).toBe(0);
  });
});
