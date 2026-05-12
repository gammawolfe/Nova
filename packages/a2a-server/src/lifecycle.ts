// packages/a2a-server/src/lifecycle.ts
//
// H1 — Graceful shutdown for the a2a-server.
//
// On SIGTERM/SIGINT:
//   1. Stop accepting new HTTP connections (server.close)
//   2. Drain every live SSE stream — each cleanup tells its Redis subscriber
//      to unsubscribe + quit, clears its heartbeat, and lets the response
//      end cleanly. Without this step, clients get an abrupt TCP RST
//      mid-stream when the process exits.
//   3. Close the shared Redis client (publishers, queues, indexes)
//   4. exit(0)
//
// A safety timer guarantees exit even if `server.close` hangs on a stuck
// keep-alive socket; without it, an idle long-poll could pin the process
// until OS-level kill.

import type { Server } from 'http';
import { logger } from '@nova/shared/src/logger';
import { closeSharedRedis } from '@nova/shared/src/redis';
import { drainSseStreams, liveStreamCount } from './sse-registry';

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.NOVA_SHUTDOWN_TIMEOUT_MS ?? '15000', 10);

let shuttingDown = false;

export function installShutdownHandlers(getServer: () => Server | null): void {
  const handler = (signal: string) => () => { void shutdown(signal, getServer()); };
  process.on('SIGTERM', handler('SIGTERM'));
  process.on('SIGINT', handler('SIGINT'));
}

async function shutdown(signal: string, httpServer: Server | null): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, liveStreams: liveStreamCount() }, 'a2a-server shutting down');

  // Hard exit if anything below hangs.
  const watchdog = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'a2a-server shutdown watchdog fired — exiting hard');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  try {
    // 1. stop accepting new connections
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close((err) => {
          if (err) logger.warn({ err }, 'server.close reported an error');
          resolve();
        });
      });
    }

    // 2. drain live SSE streams (idempotent with each handler's own cleanup)
    const drained = drainSseStreams();
    if (drained > 0) {
      logger.info({ drained }, 'Drained SSE streams during shutdown');
      // Brief grace period for Redis unsubscribe/quit acks to flush before
      // we close the shared client below.
      await new Promise(r => setTimeout(r, 250));
    }

    // 3. close shared Redis (publishers, queues, indexes used by handlers)
    await closeSharedRedis();

    logger.info('a2a-server shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown sequence');
  } finally {
    clearTimeout(watchdog);
    process.exit(0);
  }
}
