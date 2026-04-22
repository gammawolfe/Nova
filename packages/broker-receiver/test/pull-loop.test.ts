import { describe, it, expect, vi } from 'vitest';
import { PullLoop } from '../src/pull-loop';
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

/**
 * Build a fake client whose pull() returns from a programmable queue and
 * whose respond() is a no-op. Each queue entry is one of:
 *   { task }                — returns a PullResult
 *   null                    — returns 204 (no task)
 *   { error }               — throws the given error
 */
function fakeClient(queue: Array<{ task?: QueuedTask; error?: Error } | null>) {
  let i = 0;
  return {
    pull: vi.fn(async (_id: string, _ucan: string, waitMs: number) => {
      // Simulate the server long-poll: when the queue is exhausted and
      // we're not aborted, return 204 so the loop keeps spinning quickly.
      if (i >= queue.length) {
        await new Promise(r => setTimeout(r, Math.min(waitMs, 20)));
        return null;
      }
      const next = queue[i++];
      if (next === null) return null;
      if (next!.error) throw next!.error;
      return {
        task: next!.task!,
        visibleUntil: new Date(Date.now() + 60_000).toISOString(),
      };
    }),
    respond: vi.fn(async () => 'accepted' as const),
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

describe('PullLoop', () => {
  it('pulls tasks and dispatches them until stopped', async () => {
    const client = fakeClient([
      { task: mkTask('t1') },
      { task: mkTask('t2') },
      null,
      { task: mkTask('t3') },
    ]);
    const dispatcher = fakeDispatcher();
    const loop = new PullLoop({
      agentId: 'a',
      client: client as any,
      dispatcher: dispatcher as any,
      mintSelfUcan: () => 'ucan',
      pollWaitMs: 1_000,
      logger: nullLogger,
    });

    loop.start();
    await new Promise(r => setTimeout(r, 100));
    await loop.stop();

    expect(dispatcher.dispatched.map(t => t.taskId).sort()).toEqual(['t1', 't2', 't3']);
    expect(loop.getStats().totalTasks).toBe(3);
  });

  it('backs off on TransportError and recovers on next success', async () => {
    const client = fakeClient([
      { error: new TransportError('ECONNREFUSED') },
      { task: mkTask('t1') },
    ]);
    const dispatcher = fakeDispatcher();
    const loop = new PullLoop({
      agentId: 'a',
      client: client as any,
      dispatcher: dispatcher as any,
      mintSelfUcan: () => 'ucan',
      pollWaitMs: 1_000,
      logger: nullLogger,
    });

    loop.start();
    // First attempt fails (1s backoff). Give enough time for backoff +
    // second attempt + dispatch.
    await new Promise(r => setTimeout(r, 1_200));
    await loop.stop();

    expect(loop.getStats().totalPullErrors).toBe(1);
    expect(dispatcher.dispatched.map(t => t.taskId)).toContain('t1');
  });

  it('counts consecutive errors and resets on success', async () => {
    const client = fakeClient([
      { error: new TransportError('err1') },
      { error: new TransportError('err2') },
      { task: mkTask('ok') },
    ]);
    const dispatcher = fakeDispatcher();
    const loop = new PullLoop({
      agentId: 'a',
      client: client as any,
      dispatcher: dispatcher as any,
      mintSelfUcan: () => 'ucan',
      pollWaitMs: 1_000,
      logger: nullLogger,
    });

    loop.start();
    // Wait long enough for 2 errors (backoffs of 1s + 2s = 3s) + success.
    await new Promise(r => setTimeout(r, 3_500));
    await loop.stop();

    const stats = loop.getStats();
    expect(stats.totalPullErrors).toBe(2);
    expect(stats.consecutiveErrors).toBe(0); // reset on success
    expect(dispatcher.dispatched.map(t => t.taskId)).toContain('ok');
  });

  it('backs off on HttpError (e.g. 401 UCAN_INVALID)', async () => {
    const client = fakeClient([
      { error: new HttpError('unauth', 401, { error: 'UCAN_INVALID' }) },
      { task: mkTask('t1') },
    ]);
    const dispatcher = fakeDispatcher();
    const loop = new PullLoop({
      agentId: 'a',
      client: client as any,
      dispatcher: dispatcher as any,
      mintSelfUcan: () => 'ucan',
      pollWaitMs: 1_000,
      logger: nullLogger,
    });

    loop.start();
    await new Promise(r => setTimeout(r, 1_200));
    await loop.stop();

    expect(loop.getStats().totalPullErrors).toBe(1);
    expect(dispatcher.dispatched.map(t => t.taskId)).toContain('t1');
  });

  it('stops promptly when dispatcher is full', async () => {
    const client = fakeClient([{ task: mkTask('t1') }]);
    const dispatcher = fakeDispatcher();
    dispatcher.isFull = true; // never drains, pull loop should park
    const loop = new PullLoop({
      agentId: 'a',
      client: client as any,
      dispatcher: dispatcher as any,
      mintSelfUcan: () => 'ucan',
      pollWaitMs: 1_000,
      logger: nullLogger,
    });

    loop.start();
    await new Promise(r => setTimeout(r, 100));
    await loop.stop();

    expect(client.pull).not.toHaveBeenCalled();
    expect(dispatcher.dispatched).toHaveLength(0);
  });

  it('stop() during long-poll aborts cleanly via signal', async () => {
    // Simulate a real 30s long-poll: pull respects the abort signal.
    let resolved = false;
    const client = {
      pull: vi.fn(async (_id: string, _ucan: string, _waitMs: number, signal?: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 5_000);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
        resolved = true;
        return null;
      }),
      respond: vi.fn(),
    };
    const dispatcher = fakeDispatcher();
    const loop = new PullLoop({
      agentId: 'a',
      client: client as any,
      dispatcher: dispatcher as any,
      mintSelfUcan: () => 'ucan',
      pollWaitMs: 30_000,
      logger: nullLogger,
    });

    const start = Date.now();
    loop.start();
    await new Promise(r => setTimeout(r, 50));
    await loop.stop();
    const elapsed = Date.now() - start;

    expect(resolved).toBe(false);
    expect(elapsed).toBeLessThan(1_000); // stopped long before the fake 5s pull would have
  });
});
