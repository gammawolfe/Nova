import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../src/dispatcher';
import type { Handler, HandlerResult, Logger } from '../src/handlers/index';
import type { QueuedTask } from '@nova/shared/src/types';

function mkTask(taskId: string, intent = 'chat'): QueuedTask {
  return {
    taskId,
    tenantId: 't',
    agentId: 'a',
    intent,
    params: { q: 'hi' },
    senderDid: 'did:key:zTest',
    tier: 1,
    queuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    schemaVersion: '1.0',
  } as unknown as QueuedTask;
}

const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function mkFakeClient(): {
  respond: (typeof Dispatcher.prototype['opts']) extends never ? never : any;
  calls: Array<{ taskId: string; body: any }>;
} {
  const calls: Array<{ taskId: string; body: any }> = [];
  const respond = vi.fn(async (_agentId: string, _ucan: string, taskId: string, body: any) => {
    calls.push({ taskId, body });
    return 'accepted';
  });
  return { respond, calls } as any;
}

describe('Dispatcher', () => {
  it('runs the handler and ships the result via respond', async () => {
    const { respond, calls } = mkFakeClient();
    const handler: Handler = {
      name: 'fake',
      handle: async () => ({ status: 'ok', result: { ok: true } }) as HandlerResult,
    };
    const d = new Dispatcher({
      agentId: 'a',
      handler,
      client: { respond } as any,
      mintSelfUcan: () => 'ucan',
      maxConcurrentTasks: 1,
      logger: nullLogger,
    });

    await d.dispatch(mkTask('t1'), new Date(Date.now() + 60_000).toISOString());

    expect(calls.length).toBe(1);
    expect(calls[0]!.taskId).toBe('t1');
    expect(calls[0]!.body).toEqual({ status: 'ok', result: { ok: true } });
    expect(d.currentInFlight).toBe(0);
    expect(d.getStats().totalResponded).toBe(1);
  });

  it('converts handler throw into status:error HANDLER_EXCEPTION respond', async () => {
    const { respond, calls } = mkFakeClient();
    const handler: Handler = {
      name: 'boom',
      handle: async () => { throw new Error('boom'); },
    };
    const d = new Dispatcher({
      agentId: 'a',
      handler,
      client: { respond } as any,
      mintSelfUcan: () => 'ucan',
      maxConcurrentTasks: 1,
      logger: nullLogger,
    });

    await d.dispatch(mkTask('t1'), new Date(Date.now() + 60_000).toISOString());

    expect(calls[0]!.body.status).toBe('error');
    expect(calls[0]!.body.error.code).toBe('HANDLER_EXCEPTION');
    expect(d.getStats().totalHandlerErrors).toBe(1);
    expect(d.getStats().totalResponded).toBe(1);
  });

  it('counts transport error on respond failure and does not crash', async () => {
    const respond = vi.fn(async () => { throw new Error('network down'); });
    const handler: Handler = {
      name: 'ok',
      handle: async () => ({ status: 'ok', result: {} }) as HandlerResult,
    };
    const d = new Dispatcher({
      agentId: 'a',
      handler,
      client: { respond } as any,
      mintSelfUcan: () => 'ucan',
      maxConcurrentTasks: 1,
      logger: nullLogger,
    });

    await d.dispatch(mkTask('t1'), new Date(Date.now() + 60_000).toISOString());

    expect(d.getStats().totalTransportErrors).toBe(1);
    expect(d.currentInFlight).toBe(0);
  });

  it('fires handler AbortSignal ~30s before visibleUntil', async () => {
    const { respond } = mkFakeClient();
    let observedAborted = false;
    const handler: Handler = {
      name: 'watcher',
      handle: async (_task, ctx) => {
        // Wait ~50ms after abort fires, then check signal state.
        await new Promise(r => setTimeout(r, 50));
        observedAborted = ctx.signal.aborted;
        return { status: 'ok', result: {} } as HandlerResult;
      },
    };
    const d = new Dispatcher({
      agentId: 'a',
      handler,
      client: { respond } as any,
      mintSelfUcan: () => 'ucan',
      maxConcurrentTasks: 1,
      logger: nullLogger,
    });

    // visibleUntil = now + 30s + 10ms → abort fires ~10ms in
    const visibleUntil = new Date(Date.now() + 30_010).toISOString();
    await d.dispatch(mkTask('t1'), visibleUntil);

    expect(observedAborted).toBe(true);
  });

  it('shutdown waits for in-flight handlers up to the grace window', async () => {
    const { respond } = mkFakeClient();
    let handlerFinished = false;
    const handler: Handler = {
      name: 'slow',
      handle: async () => {
        await new Promise(r => setTimeout(r, 200));
        handlerFinished = true;
        return { status: 'ok', result: {} } as HandlerResult;
      },
    };
    const d = new Dispatcher({
      agentId: 'a',
      handler,
      client: { respond } as any,
      mintSelfUcan: () => 'ucan',
      maxConcurrentTasks: 2,
      logger: nullLogger,
    });

    const p = d.dispatch(mkTask('t1'), new Date(Date.now() + 60_000).toISOString());
    // Start shutdown while the handler is still running.
    await new Promise(r => setTimeout(r, 20));
    expect(d.currentInFlight).toBe(1);

    await d.shutdown(5); // 5 second grace; handler only needs 200ms
    await p;

    expect(handlerFinished).toBe(true);
    expect(d.currentInFlight).toBe(0);
  });

  it('shutdown aborts the handler signal immediately', async () => {
    const { respond } = mkFakeClient();
    let sawAbort = false;
    const handler: Handler = {
      name: 'abort-aware',
      handle: async (_task, ctx) => {
        ctx.signal.addEventListener('abort', () => { sawAbort = true; }, { once: true });
        await new Promise(r => setTimeout(r, 100));
        return { status: 'ok', result: {} } as HandlerResult;
      },
    };
    const d = new Dispatcher({
      agentId: 'a',
      handler,
      client: { respond } as any,
      mintSelfUcan: () => 'ucan',
      maxConcurrentTasks: 1,
      logger: nullLogger,
    });

    const p = d.dispatch(mkTask('t1'), new Date(Date.now() + 60_000).toISOString());
    await new Promise(r => setTimeout(r, 10));
    await d.shutdown(1);
    await p;
    expect(sawAbort).toBe(true);
  });

  it('rejects dispatch after shutdown', async () => {
    const { respond } = mkFakeClient();
    const handler: Handler = {
      name: 'fake',
      handle: async () => ({ status: 'ok', result: {} }) as HandlerResult,
    };
    const d = new Dispatcher({
      agentId: 'a',
      handler,
      client: { respond } as any,
      mintSelfUcan: () => 'ucan',
      maxConcurrentTasks: 1,
      logger: nullLogger,
    });

    await d.shutdown(1);
    await d.dispatch(mkTask('t1'), new Date(Date.now() + 60_000).toISOString());
    expect(d.getStats().totalDispatched).toBe(0);
  });

  it('tracks multiple concurrent in-flight tasks', async () => {
    const { respond } = mkFakeClient();
    let releases: Array<() => void> = [];
    const handler: Handler = {
      name: 'blocking',
      handle: async () => {
        await new Promise<void>(r => releases.push(r));
        return { status: 'ok', result: {} } as HandlerResult;
      },
    };
    const d = new Dispatcher({
      agentId: 'a',
      handler,
      client: { respond } as any,
      mintSelfUcan: () => 'ucan',
      maxConcurrentTasks: 3,
      logger: nullLogger,
    });

    const visibleUntil = new Date(Date.now() + 60_000).toISOString();
    const p1 = d.dispatch(mkTask('t1'), visibleUntil);
    const p2 = d.dispatch(mkTask('t2'), visibleUntil);
    await new Promise(r => setTimeout(r, 20));
    expect(d.currentInFlight).toBe(2);
    expect(d.isFull).toBe(false);

    const p3 = d.dispatch(mkTask('t3'), visibleUntil);
    await new Promise(r => setTimeout(r, 20));
    expect(d.currentInFlight).toBe(3);
    expect(d.isFull).toBe(true);

    for (const r of releases) r();
    await Promise.all([p1, p2, p3]);
    expect(d.currentInFlight).toBe(0);
    expect(d.getStats().totalResponded).toBe(3);
  });
});
