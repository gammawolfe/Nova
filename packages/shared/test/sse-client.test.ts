import { describe, it, expect, vi } from 'vitest';
import { streamSseEvents, parseSseBlock, SseEvent } from '../src/sse-client';

/**
 * Build a ReadableStream that emits the given chunks and then closes.
 * Pauses between chunks so consumers can observe intermediate state.
 */
function mkStream(chunks: string[], pauseMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      if (pauseMs > 0) await new Promise(r => setTimeout(r, pauseMs));
      controller.enqueue(encoder.encode(chunks[i++]!));
    },
  });
}

interface FakeFetchCall {
  url: string;
  headers: Record<string, string>;
}

function mkFetch(
  responses: Array<{ status: number; chunks?: string[] } | 'throw'>,
  calls: FakeFetchCall[] = [],
): typeof fetch {
  const queue = [...responses];
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
    });
    const next = queue.shift();
    if (!next) throw new Error('no more fake responses');
    if (next === 'throw') throw new Error('network boom');
    const { status, chunks = [] } = next;
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      body: ok ? mkStream(chunks) : null,
      text: async () => '',
    } as unknown as Response;
  }) as any;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('parseSseBlock', () => {
  it('parses id, event, data fields', () => {
    const evt = parseSseBlock(['id: 5', 'event: enqueued', 'data: {"taskId":"x"}']);
    expect(evt).toEqual({ id: 5, type: 'enqueued', data: '{"taskId":"x"}' });
  });

  it('defaults type to message and id to undefined when absent', () => {
    const evt = parseSseBlock(['data: hello']);
    expect(evt?.type).toBe('message');
    expect(evt?.id).toBeUndefined();
  });

  it('joins multi-line data with a newline', () => {
    const evt = parseSseBlock(['data: line1', 'data: line2']);
    expect(evt?.data).toBe('line1\nline2');
  });

  it('returns null when no data field present', () => {
    expect(parseSseBlock(['id: 1', 'event: foo'])).toBeNull();
  });

  it('ignores comment lines and empty lines', () => {
    const evt = parseSseBlock([': comment', '', 'data: hello']);
    expect(evt?.data).toBe('hello');
  });

  it('handles values without a leading space after colon', () => {
    const evt = parseSseBlock(['data:no-space']);
    expect(evt?.data).toBe('no-space');
  });
});

describe('streamSseEvents', () => {
  it('fires onEvent for each event and filters heartbeats', async () => {
    const events: SseEvent[] = [];
    const calls: FakeFetchCall[] = [];
    const controller = new AbortController();
    const fetchImpl = mkFetch([
      {
        status: 200,
        chunks: [
          'id: 1\nevent: enqueued\ndata: {"taskId":"t1"}\n\n',
          'event: heartbeat\ndata: {"at":"..."}\n\n',
          'id: 2\nevent: enqueued\ndata: {"taskId":"t2"}\n\n',
        ],
      },
      // On reconnect after clean close, return empty stream forever via a
      // response that closes immediately — caller aborts.
      { status: 200, chunks: [] },
      { status: 200, chunks: [] },
    ], calls);

    const h = streamSseEvents({
      url: 'http://x/stream',
      getHeaders: () => ({ authorization: 'Bearer ucan' }),
      onEvent: (e) => { events.push(e); },
      signal: controller.signal,
      fetchImpl,
      backoffBaseMs: 5,
      backoffCapMs: 20,
    });

    await sleep(50);
    controller.abort();
    await h.done;

    expect(events.map(e => e.id)).toEqual([1, 2]);
    expect(events.map(e => e.type)).toEqual(['enqueued', 'enqueued']);
    expect(h.stats().heartbeatsReceived).toBe(1);
    expect(h.stats().eventsReceived).toBe(2);
    expect(h.stats().lastEventId).toBe(2);
  });

  it('sends last-event-id header on reconnect', async () => {
    const calls: FakeFetchCall[] = [];
    const controller = new AbortController();
    const fetchImpl = mkFetch([
      { status: 200, chunks: ['id: 7\nevent: enqueued\ndata: {}\n\n'] },
      { status: 200, chunks: [] },
      { status: 200, chunks: [] },
    ], calls);

    const h = streamSseEvents({
      url: 'http://x/stream',
      getHeaders: () => ({ authorization: 'Bearer ucan' }),
      onEvent: () => {},
      signal: controller.signal,
      fetchImpl,
      backoffBaseMs: 5,
      backoffCapMs: 20,
    });

    await sleep(50);
    controller.abort();
    await h.done;

    expect(calls[0]!.headers['last-event-id']).toBeUndefined();
    // Subsequent reconnects carry the last event id from the first stream.
    expect(calls[1]!.headers['last-event-id']).toBe('7');
  });

  it('backs off on error responses and reconnects', async () => {
    const calls: FakeFetchCall[] = [];
    const reconnects: Array<{ attempt: number; delay: number; cause: string }> = [];
    const controller = new AbortController();
    const fetchImpl = mkFetch([
      { status: 500 },
      { status: 500 },
      { status: 200, chunks: ['id: 1\nevent: enqueued\ndata: {}\n\n'] },
      { status: 200, chunks: [] },
    ], calls);

    const h = streamSseEvents({
      url: 'http://x/stream',
      getHeaders: () => ({}),
      onEvent: () => {},
      onReconnect: (attempt, delay, cause) => reconnects.push({ attempt, delay, cause }),
      signal: controller.signal,
      fetchImpl,
      backoffBaseMs: 5,
      backoffCapMs: 20,
    });

    await sleep(100);
    controller.abort();
    await h.done;

    // First two failed, then one succeeded. Reconnect callback fires once
    // per attempt to sleep before a new connect.
    expect(reconnects.length).toBeGreaterThanOrEqual(2);
    expect(reconnects.slice(0, 2).map(r => r.cause)).toEqual(['error', 'error']);
    expect(h.stats().eventsReceived).toBe(1);
  });

  it('treats fetch throw as error and retries', async () => {
    const controller = new AbortController();
    const fetchImpl = mkFetch([
      'throw',
      { status: 200, chunks: ['id: 1\nevent: ok\ndata: {}\n\n'] },
      { status: 200, chunks: [] },
    ]);

    let sawError: string | undefined;
    const h = streamSseEvents({
      url: 'http://x/stream',
      getHeaders: () => ({}),
      onEvent: (e) => {
        // First successful event: snapshot the error that was set during the
        // earlier failed attempt, then abort so the loop stops.
        sawError = h.stats().lastError;
        controller.abort();
      },
      signal: controller.signal,
      fetchImpl,
      backoffBaseMs: 5,
      backoffCapMs: 20,
    });

    await h.done;

    expect(h.stats().eventsReceived).toBe(1);
    expect(sawError).toContain('network boom');
  });

  it('calls getHeaders fresh on every reconnect', async () => {
    const getHeaders = vi.fn(() => ({ authorization: 'Bearer fresh-' + Math.random() }));
    const controller = new AbortController();
    const fetchImpl = mkFetch([
      { status: 200, chunks: [] },
      { status: 200, chunks: [] },
      { status: 200, chunks: [] },
    ]);

    const h = streamSseEvents({
      url: 'http://x/stream',
      getHeaders,
      onEvent: () => {},
      signal: controller.signal,
      fetchImpl,
      backoffBaseMs: 5,
      backoffCapMs: 20,
    });

    await sleep(50);
    controller.abort();
    await h.done;

    expect(getHeaders).toHaveBeenCalledTimes(getHeaders.mock.calls.length);
    expect(getHeaders.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves done promptly when aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = mkFetch([{ status: 200, chunks: [] }]);

    const start = Date.now();
    const h = streamSseEvents({
      url: 'http://x/stream',
      getHeaders: () => ({}),
      onEvent: () => {},
      signal: controller.signal,
      fetchImpl,
      backoffBaseMs: 1_000,
      backoffCapMs: 60_000,
    });
    await sleep(10);
    controller.abort();
    await h.done;
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('onOpen fires once per successful connect', async () => {
    const opens: number[] = [];
    const controller = new AbortController();
    const fetchImpl = mkFetch([
      { status: 200, chunks: ['id: 1\nevent: ok\ndata: {}\n\n'] },
      { status: 500 },
      { status: 200, chunks: ['id: 2\nevent: ok\ndata: {}\n\n'] },
      { status: 200, chunks: [] },
    ]);

    const h = streamSseEvents({
      url: 'http://x/stream',
      getHeaders: () => ({}),
      onEvent: () => {},
      onOpen: () => opens.push(Date.now()),
      signal: controller.signal,
      fetchImpl,
      backoffBaseMs: 5,
      backoffCapMs: 20,
    });

    await sleep(100);
    controller.abort();
    await h.done;

    // First + third attempts opened successfully; second failed.
    expect(opens.length).toBeGreaterThanOrEqual(2);
  });
});
