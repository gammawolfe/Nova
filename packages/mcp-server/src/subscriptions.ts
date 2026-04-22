// packages/mcp-server/src/subscriptions.ts
//
// MCP resource-subscription bridge. Owns one streaming SSE connection per
// subscribed resource URI; translates SSE events into MCP
// notifications/resources/updated on the parent McpServer.
//
// Why a hand-rolled SSE client instead of undici's EventSource: EventSource's
// spec-mandated constructor shape accepts `withCredentials` only, not custom
// headers. We need to inject the agent's self-UCAN on every (re)connect, so
// it's cleaner to drive the HTTP call ourselves and parse SSE framing line
// by line.
//
// Lifecycle: subscribe(uri) → stream events → sendResourceUpdated → client
// reads the resource. Unsubscribe(uri) or shutdown() tears the connection
// down. Transport close on the parent server calls shutdown() automatically
// (wired in index.ts).

import { request } from 'undici';
import type { Readable } from 'node:stream';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { loadAgentRuntime } from './context.js';
import { loadIdentity } from './identity.js';
import { mintSelfAuthToken } from './ucan-mint.js';

export const INBOX_URI = 'nova://inbox';
export const TASK_URI_PREFIX = 'nova://tasks/';

interface Subscription {
  uri: string;
  url: string;
  abort: AbortController;
  lastEventId: number;
  stopped: boolean;
  loop: Promise<void>;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

/**
 * Resolve a resource URI to the a2a-server SSE URL that backs it.
 * Returns null for URIs this module does not manage.
 */
function resolveBackingUrl(uri: string, novaUrl: string, agentId: string): string | null {
  if (uri === INBOX_URI) {
    return `${novaUrl.replace(/\/$/, '')}/agents/${encodeURIComponent(agentId)}/inbox/stream`;
  }
  if (uri.startsWith(TASK_URI_PREFIX)) {
    const taskId = uri.slice(TASK_URI_PREFIX.length);
    if (!taskId) return null;
    return `${novaUrl.replace(/\/$/, '')}/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}/stream`;
  }
  return null;
}

/**
 * Parse an SSE event block (one message between blank lines). Returns the
 * event fields or null for non-event lines (e.g. lone comments, heartbeats
 * we don't model as events).
 */
interface SseEvent {
  id?: number;
  type: string;
  data: string;
}

function parseSseBlock(lines: string[]): SseEvent | null {
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

export class SubscriptionManager {
  private subs = new Map<string, Subscription>();
  private shuttingDown = false;

  constructor(private readonly server: Server) {}

  /**
   * Start streaming events for a resource URI. Idempotent: a second call
   * with the same URI is a no-op (the existing subscription keeps its
   * lastEventId). Throws synchronously only on malformed URIs or missing
   * runtime; transport-level failures are absorbed by the reconnect loop.
   */
  async subscribe(uri: string): Promise<void> {
    if (this.shuttingDown) return;
    if (this.subs.has(uri)) return;

    const rt = await loadAgentRuntime();
    if (!rt) throw new Error('No active agent runtime. Set NOVA_AGENT_ID.');
    const url = resolveBackingUrl(uri, rt.novaUrl, rt.agentId);
    if (!url) throw new Error(`Unsupported subscribable resource: ${uri}`);

    const abort = new AbortController();
    const sub: Subscription = {
      uri,
      url,
      abort,
      lastEventId: 0,
      stopped: false,
      loop: Promise.resolve(),
    };
    sub.loop = this.runLoop(sub);
    this.subs.set(uri, sub);
  }

  async unsubscribe(uri: string): Promise<void> {
    const sub = this.subs.get(uri);
    if (!sub) return;
    sub.stopped = true;
    sub.abort.abort();
    this.subs.delete(uri);
    // Let the loop exit on its own; we don't await it here because the
    // MCP handler response shouldn't hang on SSE teardown.
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const sub of this.subs.values()) {
      sub.stopped = true;
      sub.abort.abort();
    }
    this.subs.clear();
  }

  listSubscribed(): string[] {
    return Array.from(this.subs.keys());
  }

  private async runLoop(sub: Subscription): Promise<void> {
    let attempt = 0;
    while (!sub.stopped) {
      try {
        await this.connectAndStream(sub);
        // Server closed cleanly (e.g. terminal task state). Exit the loop.
        return;
      } catch (err: any) {
        if (sub.stopped) return;
        attempt += 1;
        const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
        await sleep(delay, sub.abort.signal);
      }
    }
  }

  private async connectAndStream(sub: Subscription): Promise<void> {
    const rt = await loadAgentRuntime();
    if (!rt) throw new Error('agent runtime gone');
    const identity = await loadIdentity(rt.agentId);
    if (!identity) throw new Error(`identity missing for ${rt.agentId}`);
    const selfUcan = mintSelfAuthToken({
      senderDid: identity.did,
      senderPrivateKeyPem: identity.privateKeyPem,
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${selfUcan}`,
      accept: 'text/event-stream',
    };
    if (sub.lastEventId > 0) {
      headers['last-event-id'] = String(sub.lastEventId);
    }

    const res = await request(sub.url, {
      method: 'GET',
      headers,
      signal: sub.abort.signal,
    });

    if (res.statusCode >= 400) {
      // Drain the body so the connection can be reused by undici's pool.
      try { await res.body.text(); } catch { /* ignore */ }
      throw new Error(`SSE connect ${res.statusCode}`);
    }

    await this.readEvents(sub, res.body as unknown as Readable);
  }

  private async readEvents(sub: Subscription, stream: Readable): Promise<void> {
    let buffer = '';
    stream.setEncoding('utf8');
    for await (const chunk of stream) {
      if (sub.stopped) return;
      buffer += chunk;
      // SSE events are terminated by a blank line (double newline).
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = block.split(/\r?\n/);
        const evt = parseSseBlock(lines);
        if (!evt) continue;
        if (evt.type === 'heartbeat') continue;
        if (evt.id !== undefined) sub.lastEventId = evt.id;
        try {
          await this.server.sendResourceUpdated({ uri: sub.uri });
        } catch {
          // Transport gone — shutdown will eventually clear us.
          return;
        }
      }
    }
  }
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
