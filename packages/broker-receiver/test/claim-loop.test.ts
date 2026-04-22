import { describe, it, expect, vi } from 'vitest';
import { ClaimLoop } from '../src/claim-loop';
import { TransportError, HttpError } from '../src/nova-client';
import type { Logger } from '../src/handlers/index';
import type { QueuedTask } from '@nova/shared/src/types';

const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function mkTask(taskId: string): QueuedTask {
  return {
    taskId,
    tenantId: 't',
    agentId: 'a',
    intent: 'chat',
    params: {},
    senderDid: 'did:key:zTest',
    tier: 1,
    queuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    schemaVersion: '1.0',
  } as unknown as QueuedTask;
}

/** Programmable client. Each pull() call returns from a queue. */
function fakeClient(queue: Array<QueuedTask | null | Error>) {
  let i = 0;
  return {
    pull: vi.fn(async () => {
      if (i >= queue.length) return null;
      const next = queue[i++];
      if (next instanceof Error) throw next;
      if (next === null) return null;
      return { task: next, visibleUntil: new Date(Date.now() + 60_000).toISOString() };
    }),
    respond: vi.fn(),
  };
}

function fakeDispatcher() {
  const dispatched: QueuedTask[] = [];
  return {
    dispatched,
    isFull: false,
    currentInFlight: 0,
    dispatch: vi.fn(async (task: QueuedTask) => {
      dispatched.push(task);
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function mkLoop(client: any, dispatcher: any, overrides: Partial<ConstructorParameters<typeof ClaimLoop>[0]> = {}): ClaimLoop {
  return new ClaimLoop({
    agentId: 'a',
    client,
    dispatcher,
    mintSelfUcan: () => 'ucan',
    novaUrl: 'http://localhost:3001',
    inboxStrategy: 'poll',           // default to no-SSE for deterministic tests
    pollFallbackMs: 60_000,           // long enough that the tick doesn't fire in fast tests
    logger: nullLogger,
    ...overrides,
  });
}

describe('ClaimLoop — poll mode', () => {
  it('claims on startup and dispatches', async () => {
    const client = fakeClient([mkTask('t1'), null]);
    const dispatcher = fakeDispatcher();
    const loop = mkLoop(client, dispatcher);

    loop.start();
    await sleep(50);
    await loop.stop();

    expect(dispatcher.dispatched.map(t => t.taskId)).toEqual(['t1']);
    expect(loop.getStats().totalTasks).toBe(1);
    expect(loop.getStats().triggers.fromTick).toBeGreaterThanOrEqual(1);
  });

  it('drains multiple tasks in one trigger cycle (coalescing)', async () => {
    const client = fakeClient([mkTask('t1'), mkTask('t2'), mkTask('t3'), null]);
    const dispatcher = fakeDispatcher();
    const loop = mkLoop(client, dispatcher);

    loop.start();
    await sleep(80);
    await loop.stop();

    expect(dispatcher.dispatched.map(t => t.taskId).sort()).toEqual(['t1', 't2', 't3']);
    expect(client.pull).toHaveBeenCalledTimes(4); // 3 tasks + 1 empty (204)
  });

  it('parks when dispatcher is full and resumes when it drains', async () => {
    const client = fakeClient([mkTask('t1'), mkTask('t2'), null]);
    const dispatcher = fakeDispatcher();
    dispatcher.isFull = true;
    const loop = mkLoop(client, dispatcher);

    loop.start();
    await sleep(30);
    expect(dispatcher.dispatched).toHaveLength(0);
    expect(client.pull).not.toHaveBeenCalled();

    dispatcher.isFull = false;
    await sleep(80);
    await loop.stop();

    expect(dispatcher.dispatched.length).toBeGreaterThan(0);
  });

  it('backs off on TransportError and recovers', async () => {
    const client = fakeClient([new TransportError('ECONNREFUSED'), mkTask('t1'), null]);
    const dispatcher = fakeDispatcher();
    const loop = mkLoop(client, dispatcher);

    loop.start();
    await sleep(1_200); // 1s backoff + retry
    await loop.stop();

    expect(loop.getStats().totalPullErrors).toBe(1);
    expect(dispatcher.dispatched.map(t => t.taskId)).toContain('t1');
  });

  it('backs off on HttpError (e.g. 401)', async () => {
    const err = new HttpError('unauth', 401, { error: 'UCAN_INVALID' });
    const client = fakeClient([err, mkTask('t1'), null]);
    const dispatcher = fakeDispatcher();
    const loop = mkLoop(client, dispatcher);

    loop.start();
    await sleep(1_200);
    await loop.stop();

    expect(loop.getStats().totalPullErrors).toBe(1);
    expect(dispatcher.dispatched.map(t => t.taskId)).toContain('t1');
  });

  it('stops promptly on shutdown with no hung timers', async () => {
    const client = fakeClient([null, null, null, null]);
    const dispatcher = fakeDispatcher();
    const loop = mkLoop(client, dispatcher, { pollFallbackMs: 1_000 });

    loop.start();
    await sleep(50);
    const start = Date.now();
    await loop.stop();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it('periodic tick re-fires claim when no SSE', async () => {
    const client = fakeClient([null, mkTask('first'), null, mkTask('second'), null]);
    const dispatcher = fakeDispatcher();
    const loop = mkLoop(client, dispatcher, { pollFallbackMs: 100 });

    loop.start();
    await sleep(350); // enough ticks to hit both tasks
    await loop.stop();

    expect(dispatcher.dispatched.map(t => t.taskId).sort()).toEqual(['first', 'second']);
    expect(loop.getStats().triggers.fromTick).toBeGreaterThanOrEqual(2);
  });

  it('reports sse.enabled=false in poll mode', async () => {
    const client = fakeClient([null]);
    const dispatcher = fakeDispatcher();
    const loop = mkLoop(client, dispatcher);

    loop.start();
    await sleep(30);
    const stats = loop.getStats();
    await loop.stop();

    expect(stats.sse.enabled).toBe(false);
    expect(stats.sse.connected).toBe(false);
  });
});

describe('ClaimLoop — push mode', () => {
  it('reports sse.enabled=true when inboxStrategy=push', async () => {
    const client = fakeClient([null]);
    const dispatcher = fakeDispatcher();
    const loop = mkLoop(client, dispatcher, { inboxStrategy: 'push', novaUrl: 'http://127.0.0.1:1' });

    loop.start();
    await sleep(30);
    const stats = loop.getStats();
    await loop.stop();

    expect(stats.sse.enabled).toBe(true);
    // SSE won't actually connect to port 1; we just verify the stat is exposed.
  });
});
