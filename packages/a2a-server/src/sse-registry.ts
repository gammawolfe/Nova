// packages/a2a-server/src/sse-registry.ts
//
// H1 — Live SSE-stream registry, used by the graceful-shutdown sequence.
//
// Each SSE handler in this service (stream.ts, routes/inbox.ts, routes/replies.ts)
// opens a dedicated Redis subscriber via `redis.duplicate()` plus a heartbeat
// timer and a request-close listener. On a normal client disconnect the local
// `cleanup()` closure tears all of that down. On a deploy-time SIGTERM, the
// process exits before the OS-level TCP close arrives, leaving subscribers and
// timers dangling — and live clients get an abrupt connection reset rather
// than a clean stream end.
//
// The fix is a tiny registry: every SSE handler registers its `cleanup`
// function on entry and removes itself on natural close. The shutdown handler
// invokes everyone's cleanup BEFORE `server.close()` resolves, so each open
// stream gets a chance to send a final SSE comment, drop its Redis sub, and
// close the response cleanly within the keep-alive grace window.
//
// The registry is intentionally a Set keyed by callback identity: cleanups
// are idempotent (`if (cleaned) return;` at the top of each), so a stream that
// closes naturally and then gets walked again during shutdown is harmless.
//
// Not used: a Map keyed by streamId. We don't need to address individual
// streams from anywhere — the only operation is "drain everyone".

import { logger } from '@nova/shared/src/logger';

type Cleanup = () => void;

const liveStreams = new Set<Cleanup>();

/**
 * Register an SSE cleanup callback. Returns an unregister function the
 * handler should call when it tears itself down naturally (req close,
 * terminal status, error). Calling it more than once is a no-op.
 */
export function registerSseCleanup(cleanup: Cleanup): () => void {
  liveStreams.add(cleanup);
  return () => liveStreams.delete(cleanup);
}

export function liveStreamCount(): number {
  return liveStreams.size;
}

/**
 * Invoke every registered cleanup. Each handler's cleanup is wrapped in
 * try/catch so one broken closure doesn't prevent the rest from running.
 * Synchronous: cleanups themselves do `unsubscribe().catch(...)` and
 * `quit().catch(...)` without awaiting — the shutdown sequence then waits
 * a short grace window for the in-flight Redis ops to finish before the
 * process exits.
 */
export function drainSseStreams(): number {
  const count = liveStreams.size;
  for (const cleanup of liveStreams) {
    try {
      cleanup();
    } catch (err) {
      logger.warn({ err }, 'SSE cleanup threw during shutdown drain');
    }
  }
  liveStreams.clear();
  return count;
}
