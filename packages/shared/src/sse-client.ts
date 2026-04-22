// packages/shared/src/sse-client.ts
//
// Reusable streaming SSE client. Replaces the hand-rolled parsers that used
// to live in packages/mcp-server/src/subscriptions.ts and was about to be
// duplicated in packages/broker-receiver. Uses Node's built-in fetch so we
// don't take on an undici dep from shared.
//
// Why not the built-in EventSource constructor: it accepts `withCredentials`
// only, not custom headers. Our authenticated streams need the self-UCAN in
// the Authorization header, and the UCAN has to be re-minted on each
// reconnect to stay within the token's 5-minute TTL. Driving the HTTP call
// ourselves makes that straightforward.
//
// Contract:
//   • `getHeaders` is called before each (re)connect, giving callers a hook
//     to mint fresh credentials.
//   • `onEvent` fires for every non-heartbeat event. The shared client does
//     not interpret event payloads — the caller decides when (if ever) to
//     abort based on event content.
//   • On server-side close, the client reconnects. Callers that want to
//     stop on terminal events should call `signal.abort()` from onEvent.
//   • Backoff is exponential capped at 60s. Resets on first event received
//     from a fresh connection.

const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 60_000;

export interface SseEvent {
  id?: number;
  type: string;
  data: string;
}

export type ReconnectCause = 'closed' | 'error';

export interface SseStreamOptions {
  url: string;
  /** Called before each (re)connect. Lets callers inject a freshly-minted UCAN. */
  getHeaders: () => Promise<Record<string, string>> | Record<string, string>;
  /** Called for each non-heartbeat event received. */
  onEvent: (event: SseEvent) => void | Promise<void>;
  /** Called when a new upstream connection opens. */
  onOpen?: () => void;
  /** Called just before sleeping for reconnect backoff. */
  onReconnect?: (attempt: number, delayMs: number, cause: ReconnectCause) => void;
  /** Abort terminates the client. Required — streamSseEvents never resolves otherwise. */
  signal: AbortSignal;
  /** Override for tests. */
  backoffBaseMs?: number;
  /** Override for tests. */
  backoffCapMs?: number;
  /**
   * Fetch implementation. Defaults to the global `fetch`. Tests pass a stub;
   * exotic deployments (self-signed certs, custom dispatchers) can pass a
   * configured undici dispatcher-aware fetch.
   */
  fetchImpl?: typeof fetch;
}

export interface SseStats {
  connected: boolean;
  reconnectCount: number;
  eventsReceived: number;
  heartbeatsReceived: number;
  lastEventId: number;
  lastOpenedAt?: string;
  lastEventAt?: string;
  lastError?: string;
}

export interface SseStreamHandle {
  /** Resolves once the AbortSignal fires and the loop exits. */
  readonly done: Promise<void>;
  /** Live snapshot. Safe to call at any time. */
  stats: () => SseStats;
}

export function streamSseEvents(opts: SseStreamOptions): SseStreamHandle {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const backoffBase = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCap = opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;

  const state: SseStats = {
    connected: false,
    reconnectCount: 0,
    eventsReceived: 0,
    heartbeatsReceived: 0,
    lastEventId: 0,
  };

  const done = runLoop();

  return {
    done,
    stats: () => ({ ...state }),
  };

  async function runLoop(): Promise<void> {
    let consecutiveErrors = 0;
    while (!opts.signal.aborted) {
      let cause: ReconnectCause = 'closed';
      try {
        const headers = await opts.getHeaders();
        if (state.lastEventId > 0) {
          headers['last-event-id'] = String(state.lastEventId);
        }
        headers['accept'] = headers['accept'] ?? 'text/event-stream';

        const res = await fetchImpl(opts.url, {
          method: 'GET',
          headers,
          signal: opts.signal,
        });
        if (!res.ok || !res.body) {
          try { await res.text?.(); } catch { /* drain */ }
          throw new Error(`sse connect ${res.status}`);
        }

        state.connected = true;
        state.lastOpenedAt = new Date().toISOString();
        consecutiveErrors = 0;
        opts.onOpen?.();

        await readStream(res.body, state, opts);
        // Stream ended cleanly — server-initiated close. Reconnect.
        state.connected = false;
      } catch (err: any) {
        state.connected = false;
        if (opts.signal.aborted) return;
        cause = 'error';
        consecutiveErrors += 1;
        state.lastError = err?.message ?? String(err);
      }

      if (opts.signal.aborted) return;
      state.reconnectCount += 1;
      const attempt = Math.max(1, consecutiveErrors);
      const delay = Math.min(backoffCap, backoffBase * 2 ** (attempt - 1));
      opts.onReconnect?.(state.reconnectCount, delay, cause);
      await sleep(delay, opts.signal);
    }
  }
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  state: SseStats,
  opts: SseStreamOptions,
): Promise<void> {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';

  try {
    while (!opts.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = block.split(/\r?\n/);
        const evt = parseSseBlock(lines);
        if (!evt) continue;
        if (evt.type === 'heartbeat') {
          state.heartbeatsReceived += 1;
          continue;
        }
        state.eventsReceived += 1;
        state.lastEventAt = new Date().toISOString();
        if (evt.id !== undefined) state.lastEventId = evt.id;
        await opts.onEvent(evt);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* best-effort */ }
  }
}

export function parseSseBlock(lines: string[]): SseEvent | null {
  let id: number | undefined;
  let type = 'message';
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue;
    const sep = line.indexOf(':');
    const field = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '');
    if (field === 'id') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) id = n;
    } else if (field === 'event') {
      type = value;
    } else if (field === 'data') {
      dataParts.push(value);
    }
  }
  if (dataParts.length === 0) return null;
  const evt: SseEvent = { type, data: dataParts.join('\n') };
  if (id !== undefined) evt.id = id;
  return evt;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
