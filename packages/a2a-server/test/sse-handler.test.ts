// packages/a2a-server/test/sse-handler.test.ts
//
// Covers the shared createSseHandler factory backing the three SSE endpoints.
// Hits each path: header setup, replay, live forwarding, replay/live dedup,
// Last-Event-ID filtering, terminal close (replay + live + postReplay
// fast-path), heartbeat ticks, cleanup on req.close / sub.error / subscribe
// failure, and the resume-gap pattern (buffered live events drained after
// replay).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// Each test creates a fresh fake subscriber. `getSharedRedis().duplicate()`
// returns a sub whose `subscribe`/`unsubscribe`/`quit` are awaited by the
// factory; we drive `.emit('message', channel, payload)` to inject events.

class FakeSub extends EventEmitter {
  subscribeCalls: string[] = [];
  unsubscribeCalled = 0;
  quitCalled = 0;
  subscribeShouldFail = false;
  async subscribe(channel: string): Promise<void> {
    if (this.subscribeShouldFail) throw new Error('subscribe failed');
    this.subscribeCalls.push(channel);
  }
  async unsubscribe(): Promise<void> { this.unsubscribeCalled++; }
  async quit(): Promise<void> { this.quitCalled++; }
}

let currentSub: FakeSub;
const sseIncCalls = vi.fn();
const sseDecCalls = vi.fn();

vi.mock('@nova/shared/src/redis', () => ({
  getSharedRedis: () => ({
    duplicate: () => currentSub,
  }),
}));

vi.mock('../src/metrics', () => ({
  activeSseStreams: {
    inc: () => sseIncCalls(),
    dec: () => sseDecCalls(),
  },
}));

vi.mock('../src/sse-registry', () => ({
  registerSseCleanup: (cb: () => void) => {
    cleanups.add(cb);
    return () => cleanups.delete(cb);
  },
}));

vi.mock('@nova/shared/src/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  },
}));

const cleanups = new Set<() => void>();

import { createSseHandler, SseEvent } from '../src/sse-handler';

// ── Request / Response harness ──────────────────────────────────────────────
//
// Minimal req/res surface needed by the factory. We don't need a real
// express.Response — only the methods called inside sse-handler.ts.

interface WrittenChunk { kind: 'write' | 'header' | 'flushHeaders' | 'end'; payload?: any }

function makeRes() {
  const chunks: WrittenChunk[] = [];
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => { headers[k] = v; chunks.push({ kind: 'header', payload: { [k]: v } }); },
    flushHeaders: () => { chunks.push({ kind: 'flushHeaders' }); },
    write: (s: string) => { chunks.push({ kind: 'write', payload: s }); return true; },
    end: vi.fn(() => { chunks.push({ kind: 'end' }); }),
    flush: () => {},
  };
  return { res, chunks, headers };
}

function makeReq(opts: { lastEventId?: number; params?: Record<string, string>; ctx?: any } = {}) {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  if (opts.lastEventId !== undefined) headers['last-event-id'] = String(opts.lastEventId);
  return Object.assign(emitter, {
    headers,
    params: opts.params ?? {},
    ctx: opts.ctx,
  });
}

/** Pull written `data:` payloads out of the response chunks in order. */
function dataPayloads(chunks: WrittenChunk[]): string[] {
  return chunks
    .filter(c => c.kind === 'write' && typeof c.payload === 'string' && c.payload.startsWith('data:'))
    .map(c => (c.payload as string).slice('data: '.length).replace(/\n+$/, ''));
}

/** Pull `event:` types out of the response chunks. */
function eventTypes(chunks: WrittenChunk[]): string[] {
  return chunks
    .filter(c => c.kind === 'write' && typeof c.payload === 'string' && c.payload.startsWith('event:'))
    .map(c => (c.payload as string).slice('event: '.length).replace(/\n+$/, ''));
}

beforeEach(() => {
  currentSub = new FakeSub();
  cleanups.clear();
  sseIncCalls.mockClear();
  sseDecCalls.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createSseHandler', () => {
  it('sets SSE headers and registers in the global registry', async () => {
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      // eslint-disable-next-line require-yield
      async *replay() { return; },
      parseLive: () => null,
    });
    const { res, headers } = makeRes();
    const req = makeReq();
    const p = handler(req as any, res as any);
    await Promise.resolve(); // let subscribe + replay complete
    await p;

    expect(headers['Content-Type']).toBe('text/event-stream');
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(headers['Connection']).toBe('keep-alive');
    expect(headers['X-Accel-Buffering']).toBe('no');
    expect(sseIncCalls).toHaveBeenCalledOnce();
    // Cleanup happens via req.close, not on natural replay end — replay
    // ending leaves the connection in 'live' mode waiting for events.
  });

  it('emits replay events with id+type+data, skipping ids <= Last-Event-ID', async () => {
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      async *replay() {
        yield { id: 1, type: 'enqueued', data: { seq: 1 } };
        yield { id: 2, type: 'enqueued', data: { seq: 2 } };
        yield { id: 3, type: 'enqueued', data: { seq: 3 } };
      },
      parseLive: () => null,
    });
    const { res, chunks } = makeRes();
    const req = makeReq({ lastEventId: 2 });
    await handler(req as any, res as any);

    // Heartbeat may fire 0 times here since we use fake timers; checking
    // only the data payload sequence.
    const payloads = dataPayloads(chunks);
    expect(payloads).toEqual([JSON.stringify({ seq: 3 })]);
  });

  it('subscribes to the channel before starting replay (resume-gap pattern)', async () => {
    let replayStarted = false;
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'my-chan',
      async *replay() {
        replayStarted = true;
        // The subscribe call must have completed BEFORE replay starts so
        // any live event arriving during replay is buffered.
        expect(currentSub.subscribeCalls).toEqual(['my-chan']);
      },
      parseLive: () => null,
    });
    const { res } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);
    expect(replayStarted).toBe(true);
  });

  it('buffers live events during replay and drains them after, deduping by id', async () => {
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      async *replay() {
        // Inject a live event mid-replay — the factory must buffer it.
        currentSub.emit('message', 'chan', JSON.stringify({ seq: 2, taskId: 't2' }));
        yield { id: 1, type: 'enqueued', data: { seq: 1, taskId: 't1' } };
        // Same seq as in replay — should be deduped from the buffer drain.
        currentSub.emit('message', 'chan', JSON.stringify({ seq: 1, taskId: 't1-dup' }));
        yield { id: 3, type: 'enqueued', data: { seq: 3, taskId: 't3' } };
      },
      parseLive(raw) {
        const note = JSON.parse(raw) as { seq: number; taskId: string };
        return { id: note.seq, type: 'enqueued', data: note };
      },
    });
    const { res, chunks } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    const payloads = dataPayloads(chunks).map(p => JSON.parse(p));
    // Replay: 1, 3. Buffered drain: 2 (seq 1 deduped). Heartbeats not yet
    // fired under fake timers.
    expect(payloads.map(p => p.taskId)).toEqual(['t1', 't3', 't2']);
  });

  it('forwards live events after replay drains, skipping replayed ids', async () => {
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      async *replay() {
        yield { id: 5, type: 'enqueued', data: { seq: 5 } };
      },
      parseLive(raw) {
        const note = JSON.parse(raw) as { seq: number };
        return { id: note.seq, type: 'enqueued', data: note };
      },
    });
    const { res, chunks } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    // Now in live mode — emit two events; one duplicates the replay id.
    currentSub.emit('message', 'chan', JSON.stringify({ seq: 5 }));
    currentSub.emit('message', 'chan', JSON.stringify({ seq: 6 }));

    const payloads = dataPayloads(chunks).map(p => JSON.parse(p));
    expect(payloads.map(p => p.seq)).toEqual([5, 6]); // 5 from replay, 6 live; live-5 deduped
  });

  it('closes on isTerminal during replay', async () => {
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      async *replay() {
        yield { id: 1, type: 'enqueued', data: { status: 'submitted' } };
        yield { id: 2, type: 'result', data: { status: 'done' } };
        // Should NEVER reach this — isTerminal closes after id=2.
        yield { id: 3, type: 'enqueued', data: { status: 'extra' } };
      },
      parseLive: () => null,
      isTerminal: (e) => e.type === 'result',
    });
    const { res, chunks } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    expect(res.end).toHaveBeenCalled();
    expect(eventTypes(chunks)).toEqual(['enqueued', 'result']);
    expect(currentSub.quitCalled).toBe(1);
    expect(sseDecCalls).toHaveBeenCalledOnce();
  });

  it('closes on isTerminal during live phase', async () => {
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      // eslint-disable-next-line require-yield
      async *replay() { return; },
      parseLive(raw) {
        return JSON.parse(raw) as SseEvent;
      },
      isTerminal: (e) => e.type === 'result',
    });
    const { res, chunks } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    currentSub.emit('message', 'chan', JSON.stringify({ id: 7, type: 'result', data: { status: 'done' } }));
    expect(res.end).toHaveBeenCalled();
    expect(eventTypes(chunks)).toEqual(['result']);
    expect(currentSub.quitCalled).toBe(1);
  });

  it('invokes postReplayTerminalCheck if no replay event was terminal, closes when it returns true', async () => {
    const check = vi.fn(async (_req: any, write: (e: SseEvent) => void) => {
      write({ type: 'result', data: { status: 'done' } });
      return true;
    });
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      async *replay() {
        yield { id: 1, type: 'enqueued', data: { status: 'submitted' } };
      },
      parseLive: () => null,
      isTerminal: () => false,
      postReplayTerminalCheck: check,
    });
    const { res, chunks } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    expect(check).toHaveBeenCalledOnce();
    expect(eventTypes(chunks)).toEqual(['enqueued', 'result']);
    expect(res.end).toHaveBeenCalled();
  });

  it('skips postReplayTerminalCheck when replay already emitted a terminal event', async () => {
    const check = vi.fn();
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      async *replay() {
        yield { id: 1, type: 'result', data: { status: 'done' } };
      },
      parseLive: () => null,
      isTerminal: (e) => e.type === 'result',
      postReplayTerminalCheck: check,
    });
    const { res } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    expect(check).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  it('sends heartbeats on the configured interval', async () => {
    const handler = createSseHandler({
      logTag: 't',
      heartbeatIntervalMs: 1_000,
      channel: () => 'chan',
      // eslint-disable-next-line require-yield
      async *replay() { return; },
      parseLive: () => null,
    });
    const { res, chunks } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    expect(eventTypes(chunks).filter(t => t === 'heartbeat').length).toBe(0);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    expect(eventTypes(chunks).filter(t => t === 'heartbeat').length).toBe(2);

    // Trigger cleanup via req.close so the heartbeat timer doesn't leak.
    req.emit('close');
  });

  it('cleanup on req.close: unsubscribes, quits sub, dec counter, clears interval', async () => {
    const handler = createSseHandler({
      logTag: 't',
      heartbeatIntervalMs: 1_000,
      channel: () => 'chan',
      // eslint-disable-next-line require-yield
      async *replay() { return; },
      parseLive: () => null,
    });
    const { res } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    req.emit('close');
    expect(currentSub.unsubscribeCalled).toBe(1);
    expect(currentSub.quitCalled).toBe(1);
    expect(sseDecCalls).toHaveBeenCalledOnce();
    expect(cleanups.size).toBe(0); // unregistered
  });

  it('cleanup on sub error: ends response and tears down', async () => {
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      // eslint-disable-next-line require-yield
      async *replay() { return; },
      parseLive: () => null,
    });
    const { res } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    currentSub.emit('error', new Error('boom'));
    expect(res.end).toHaveBeenCalled();
    expect(currentSub.quitCalled).toBe(1);
  });

  it('cleanup on subscribe failure: ends without subscribing and decrements counter', async () => {
    currentSub.subscribeShouldFail = true;
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      // eslint-disable-next-line require-yield
      async *replay() {
        // Should never run — subscribe fails first.
        throw new Error('replay should not run');
      },
      parseLive: () => null,
    });
    const { res } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    expect(res.end).toHaveBeenCalled();
    expect(sseDecCalls).toHaveBeenCalledOnce();
  });

  it('parseLive returning null silently drops malformed messages', async () => {
    const handler = createSseHandler({
      logTag: 't',
      channel: () => 'chan',
      // eslint-disable-next-line require-yield
      async *replay() { return; },
      parseLive: () => null,
    });
    const { res, chunks } = makeRes();
    const req = makeReq();
    await handler(req as any, res as any);

    currentSub.emit('message', 'chan', 'garbage');
    expect(eventTypes(chunks).filter(t => t === 'enqueued').length).toBe(0);
    expect(res.end).not.toHaveBeenCalled();
    req.emit('close');
  });
});
