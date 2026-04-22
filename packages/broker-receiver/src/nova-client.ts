// packages/broker-receiver/src/nova-client.ts
//
// Minimal HTTP client for the broker inbox endpoints. We don't reuse
// mcp-server/nova-client directly because it carries a lot of sender-side
// concerns (invite flow, admin endpoints, UCAN reissue) that the daemon
// doesn't need. Keeping the surface tight means fewer reasons for a
// compromised sender to bleed into the receiver process.
//
// This module is pure I/O: callers pass in a freshly-minted self-UCAN per
// request. No caching, no auto-reconnect, no retry. The pull-loop module
// owns retry policy.

import { request } from 'undici';
import type { QueuedTask } from '@nova/shared/src/types';

export interface NovaClientOptions {
  novaUrl: string;
  fetchImpl?: typeof request;
}

export interface PullResult {
  task: QueuedTask;
  visibleUntil: string;
}

export interface RespondBody {
  status: 'ok' | 'error';
  result?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
}

export type RespondOutcome = 'accepted' | 'already_completed' | 'task_not_found';

function join(base: string, p: string): string {
  return base.replace(/\/$/, '') + (p.startsWith('/') ? p : `/${p}`);
}

/**
 * Thrown for network-layer failures (refused connection, DNS, undici
 * dispatcher error). The pull loop treats these as transient and backs off.
 */
export class TransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TransportError';
    (this as any).cause = cause;
  }
}

/**
 * Thrown for 4xx/5xx responses the caller did not expect. Includes the
 * parsed body (if JSON) so the pull loop can log meaningful detail.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NovaBrokerClient {
  private readonly request: typeof request;

  constructor(private readonly opts: NovaClientOptions) {
    this.request = opts.fetchImpl ?? request;
  }

  /**
   * Long-poll the agent's inbox for the next task. Returns null on 204 (no
   * task within wait window). Claims the task into an in-flight state with
   * a visibility timeout — the caller must call `respond` before it
   * expires or the task will be redelivered.
   */
  async pull(agentId: string, selfUcan: string, waitMs: number, signal?: AbortSignal): Promise<PullResult | null> {
    const url = join(this.opts.novaUrl, `/agents/${encodeURIComponent(agentId)}/inbox?wait=${waitMs}`);
    let res;
    try {
      res = await this.request(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${selfUcan}` },
        signal,
      });
    } catch (err: any) {
      throw new TransportError(`inbox pull transport error: ${err.message ?? err}`, err);
    }
    if (res.statusCode === 204) {
      try { await res.body.text(); } catch { /* drain */ }
      return null;
    }
    const text = await res.body.text();
    const parsed = safeJson(text);
    if (res.statusCode >= 400) {
      throw new HttpError(`inbox pull ${res.statusCode}`, res.statusCode, parsed ?? text);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new HttpError('inbox pull returned non-object body', res.statusCode, text);
    }
    return parsed as PullResult;
  }

  /**
   * Complete an in-flight task. Idempotent: second call with the same
   * taskId returns 'already_completed'. Returns 'task_not_found' on 404,
   * which includes the "reclaimed before respond" race — the caller
   * should log and move on, not retry.
   */
  async respond(
    agentId: string,
    selfUcan: string,
    taskId: string,
    body: RespondBody,
  ): Promise<RespondOutcome> {
    const url = join(
      this.opts.novaUrl,
      `/agents/${encodeURIComponent(agentId)}/inbox/${encodeURIComponent(taskId)}/respond`,
    );
    let res;
    try {
      res = await this.request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${selfUcan}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      throw new TransportError(`inbox respond transport error: ${err.message ?? err}`, err);
    }
    const text = await res.body.text();
    const parsed = safeJson(text);

    if (res.statusCode === 202) return 'accepted';
    if (res.statusCode === 409) return 'already_completed';
    if (res.statusCode === 404) return 'task_not_found';
    throw new HttpError(`inbox respond ${res.statusCode}`, res.statusCode, parsed ?? text);
  }
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
