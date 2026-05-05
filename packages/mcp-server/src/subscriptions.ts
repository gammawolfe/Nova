// packages/mcp-server/src/subscriptions.ts
//
// MCP resource-subscription bridge. Owns one SSE stream per subscribed
// resource URI and translates each server-sent event into an MCP
// notifications/resources/updated on the parent McpServer.
//
// The SSE parser + reconnect loop live in @nova/shared so
// the broker-receiver daemon can reuse the same primitive without the MCP
// concerns this module adds (resource URI → backing URL resolution,
// server.sendResourceUpdated integration, per-URI lifecycle).

import { streamSseEvents, SseEvent, SseStreamHandle } from '@nova/shared';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { loadAgentRuntime } from './context.js';
import { loadIdentity } from '@nova/shared';
import { mintSelfAuthToken } from '@nova/shared';

export const INBOX_URI = 'nova://inbox';
export const REPLIES_URI = 'nova://replies';
export const TASK_URI_PREFIX = 'nova://tasks/';

interface Subscription {
  uri: string;
  abort: AbortController;
  handle: SseStreamHandle;
  stopped: boolean;
}

/**
 * Resolve a resource URI to the a2a-server SSE URL that backs it.
 * Returns null for URIs this module does not manage.
 */
function resolveBackingUrl(uri: string, novaUrl: string, agentId: string): string | null {
  const base = novaUrl.replace(/\/$/, '');
  if (uri === INBOX_URI) {
    return `${base}/agents/${encodeURIComponent(agentId)}/inbox/stream`;
  }
  if (uri === REPLIES_URI) {
    return `${base}/agents/${encodeURIComponent(agentId)}/replies/stream`;
  }
  if (uri.startsWith(TASK_URI_PREFIX)) {
    const taskId = uri.slice(TASK_URI_PREFIX.length);
    if (!taskId) return null;
    return `${base}/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}/stream`;
  }
  return null;
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'canceled']);

export class SubscriptionManager {
  private subs = new Map<string, Subscription>();
  private shuttingDown = false;

  constructor(private readonly server: Server) {}

  /**
   * Start streaming events for a resource URI. Idempotent: a second call
   * with the same URI is a no-op. Throws synchronously only on malformed
   * URIs or missing runtime; transport-level failures are absorbed by the
   * shared SSE client's reconnect loop.
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
      abort,
      stopped: false,
      handle: streamSseEvents({
        url,
        signal: abort.signal,
        getHeaders: async () => {
          const identity = await loadIdentity(rt.agentId);
          if (!identity) throw new Error(`identity missing for ${rt.agentId}`);
          const ucan = mintSelfAuthToken({
            senderDid: identity.did,
            senderPrivateKeyPem: identity.privateKeyPem,
          });
          return { authorization: `Bearer ${ucan}` };
        },
        onEvent: async (evt: SseEvent) => {
          // Task streams terminate server-side on final state; the shared
          // client would otherwise reconnect forever against a stream that
          // replays the terminal event and closes. Detect terminal state
          // from the event payload and abort the subscription.
          if (uri.startsWith(TASK_URI_PREFIX) && evt.type === 'result') {
            try {
              const parsed = JSON.parse(evt.data);
              const status = typeof parsed?.status === 'string' ? parsed.status : undefined;
              if (status && TERMINAL_TASK_STATUSES.has(status)) {
                abort.abort();
              }
            } catch {
              // Non-JSON payload — leave the stream alone.
            }
          }
          try {
            await this.server.sendResourceUpdated({ uri });
          } catch {
            // Transport gone — shutdown will clear us.
            abort.abort();
          }
        },
      }),
    };
    this.subs.set(uri, sub);
  }

  async unsubscribe(uri: string): Promise<void> {
    const sub = this.subs.get(uri);
    if (!sub) return;
    sub.stopped = true;
    sub.abort.abort();
    this.subs.delete(uri);
    // Don't await sub.handle.done — MCP unsubscribe response shouldn't hang
    // on SSE teardown.
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
}
