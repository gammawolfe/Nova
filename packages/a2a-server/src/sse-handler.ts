// packages/a2a-server/src/sse-handler.ts
//
// Shared SSE handler factory used by the three Server-Sent-Events endpoints:
//   - GET /agents/:agentId/tasks/:taskId/stream     (task status events)
//   - GET /agents/:agentId/inbox/stream             (broker inbox notifications)
//   - GET /agents/:agentId/replies/stream           (broker reply-inbox notifications)
//
// All three share an identical scaffold — Last-Event-ID parsing, response
// headers, heartbeat interval, Redis pub/sub subscriber with cleanup, the
// SSE registry hookup used by graceful shutdown, the subscribe-first-then-
// replay-then-flush-buffered ordering needed to close the resume gap, and
// the id-based dedup between replay and live messages.
//
// The only per-endpoint pieces are:
//   - channel(req) → string                    which pub/sub channel to subscribe
//   - replay(req, { lastEventId }) AsyncIter   replay source (event log or queue snapshot)
//   - parseLive(raw) → SseEvent | null         parse a pub/sub message
//   - isTerminal?(event) → boolean             optional: close stream on this event
//   - postReplayTerminalCheck?(req, write)     optional: fast-path for already-terminal state
//
// Tests live in test/sse-handler.test.ts.

import type IORedis from 'ioredis';
import type { Request, Response } from 'express';
import crypto from 'crypto';
import { logger } from '@nova/shared/src/logger';
import { getSharedRedis } from '@nova/shared/src/redis';
import { activeSseStreams } from './metrics';
import { registerSseCleanup } from './sse-registry';

export interface SseEvent {
  /** SSE event id used for resume + dedup between replay and live phases. */
  id?: number;
  type: string;
  data: unknown;
}

export interface SseHandlerConfig {
  /** Identifier used in error logs. */
  logTag: string;
  /** Heartbeat interval (ms). Default 15_000. */
  heartbeatIntervalMs?: number;
  /** Resolve the pub/sub channel for this connection. Called after auth. */
  channel(req: Request): string;
  /**
   * Yield replay events in id-order. Called after the subscriber is in place
   * so live events arriving during replay are buffered and merged in.
   */
  replay(req: Request, opts: { lastEventId: number }): AsyncIterable<SseEvent>;
  /**
   * Parse a raw pub/sub message into an SSE event, or return null to drop.
   */
  parseLive(raw: string): SseEvent | null;
  /**
   * Optional: an event whose payload signals end-of-stream. Used by the
   * task-status stream (status reached `done`/`failed`/etc.). The handler
   * writes the event, then closes the response.
   */
  isTerminal?(event: SseEvent): boolean;
  /**
   * Optional fast-path invoked after replay if no terminal event was seen.
   * Used by the task-status stream for the case "task became terminal
   * before the client connected and the terminal event isn't in the log."
   * Should write any final event(s) via `write` and return true to close.
   */
  postReplayTerminalCheck?(
    req: Request,
    write: (event: SseEvent) => void,
  ): Promise<boolean>;
  /** Optional connection lifecycle hook for endpoint-specific presence. */
  onOpen?(req: Request, connectionId: string): Promise<void>;
  /** Optional heartbeat hook. Runs after the SSE heartbeat is written. */
  onHeartbeat?(req: Request, connectionId: string): Promise<void>;
  /** Optional cleanup hook. Called exactly once when the connection closes. */
  onClose?(req: Request, connectionId: string): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export function createSseHandler(config: SseHandlerConfig) {
  const heartbeatMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;

  return async function sseHandler(req: Request, res: Response): Promise<void> {
    const lastEventId = parseInt((req.headers['last-event-id'] as string) ?? '0', 10) || 0;
    const connectionId = crypto.randomUUID();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy buffering (Nginx/Caddy). Without this, downstream
    // proxies wait for the chunked body to close before forwarding,
    // which defeats the entire SSE model.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    activeSseStreams.inc();

    let cleaned = false;
    let closed = false;
    let sub: IORedis | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let unregister: (() => void) | null = null;

    function write(event: SseEvent): void {
      if (event.id !== undefined) res.write(`id: ${event.id}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.data)}\n\n`);
      if (typeof (res as any).flush === 'function') (res as any).flush();
    }

    function cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      activeSseStreams.dec();
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (unregister) {
        unregister();
        unregister = null;
      }
      if (sub) {
        sub.unsubscribe().catch(() => {});
        sub.quit().catch(() => {});
        sub = null;
      }
      config.onClose?.(req, connectionId).catch((err: any) => {
        logger.warn({ err: err.message, tag: config.logTag }, 'SSE close hook failed');
      });
    }

    unregister = registerSseCleanup(cleanup);
    req.on('close', cleanup);

    // Subscribe FIRST so live events arriving during replay are buffered.
    // Without this, an event published in the window between replay and
    // live-listen attaches to no listener and is lost — the inbox/replies
    // handlers already did this; the task-stream handler had a tiny gap.
    const buffered: string[] = [];
    const replayedIds = new Set<number>();
    let replayDone = false;

    try {
      sub = getSharedRedis().duplicate();
      await sub.subscribe(config.channel(req));
    } catch (err: any) {
      logger.error({ err: err.message, tag: config.logTag }, 'SSE subscribe failed');
      cleanup();
      return void res.end();
    }
    config.onOpen?.(req, connectionId).catch((err: any) => {
      logger.warn({ err: err.message, tag: config.logTag }, 'SSE open hook failed');
    });

    function closeWith(event?: SseEvent): void {
      if (closed) return;
      closed = true;
      if (event) write(event);
      cleanup();
      res.end();
    }

    sub.on('message', (_channel, message) => {
      if (closed) return;
      if (!replayDone) {
        buffered.push(message);
        return;
      }
      try {
        const event = config.parseLive(message);
        if (!event) return;
        if (event.id !== undefined && replayedIds.has(event.id)) return;
        if (event.id !== undefined && event.id <= lastEventId) return;
        write(event);
        if (config.isTerminal?.(event)) closeWith();
      } catch (err: any) {
        logger.warn({ err: err.message, tag: config.logTag }, 'SSE live-message handler failed');
      }
    });

    sub.on('error', (err) => {
      if (closed) return;
      logger.error({ err: err.message, tag: config.logTag }, 'SSE subscriber error');
      closeWith();
    });

    heartbeat = setInterval(() => {
      if (closed) return;
      try {
        write({ type: 'heartbeat', data: { at: new Date().toISOString() } });
        config.onHeartbeat?.(req, connectionId).catch((err: any) => {
          logger.warn({ err: err.message, tag: config.logTag }, 'SSE heartbeat hook failed');
        });
      } catch {
        cleanup();
      }
    }, heartbeatMs);

    // Replay phase.
    try {
      for await (const event of config.replay(req, { lastEventId })) {
        if (closed) return;
        if (event.id !== undefined && event.id <= lastEventId) continue;
        write(event);
        if (event.id !== undefined) replayedIds.add(event.id);
        if (config.isTerminal?.(event)) {
          closeWith();
          return;
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message, tag: config.logTag }, 'SSE replay failed');
    }

    if (closed) return;

    // Fast-path: replay yielded no terminal event but the upstream state may
    // already be terminal (race between log append and SSE connect, or
    // terminal state predating event-log retention). The task-status stream
    // uses this to synthesize a final result without waiting for a live
    // event that will never come.
    if (config.postReplayTerminalCheck) {
      try {
        const done = await config.postReplayTerminalCheck(req, write);
        if (done) {
          closeWith();
          return;
        }
      } catch (err: any) {
        logger.warn({ err: err.message, tag: config.logTag }, 'SSE postReplayTerminalCheck failed');
      }
    }

    if (closed) return;

    // Replay done — drain anything buffered during it, then go live.
    replayDone = true;
    for (const message of buffered) {
      if (closed) return;
      try {
        const event = config.parseLive(message);
        if (!event) continue;
        if (event.id !== undefined && replayedIds.has(event.id)) continue;
        if (event.id !== undefined && event.id <= lastEventId) continue;
        write(event);
        if (config.isTerminal?.(event)) {
          closeWith();
          return;
        }
      } catch {
        // Tolerated — same as live-path parse failure (already logged there).
      }
    }
    buffered.length = 0;
  };
}
