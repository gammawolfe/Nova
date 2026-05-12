// packages/agent-connector/src/lifecycle.ts
//
// Graceful shutdown for the agent-connector. On SIGTERM / SIGINT:
//   1. stop the reclaim and heartbeat timers
//   2. abort the audit drain consumer (so XREADGROUP returns instead of
//      getting torn down mid-block)
//   3. drain BullMQ workers
//   4. close the health HTTP server
//
// A watchdog forces exit if any step hangs; the handler is idempotent so
// repeated signals are no-ops.

import type { Server } from 'http';
import { logger } from '@nova/shared/src/logger';
import { stopReclaimWorker } from './reclaim-worker';
import { stopHeartbeat } from './heartbeat';
import { shutdownAllWorkers } from './worker-manager';

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.NOVA_SHUTDOWN_TIMEOUT_MS ?? '15000', 10);

let shuttingDown = false;

export interface ShutdownDeps {
  auditDrainAbort: AbortController;
  getHealthServer: () => Server | null;
}

export function installShutdownHandlers(deps: ShutdownDeps): void {
  const handler = (signal: string) => () => { void shutdown(signal, deps); };
  process.on('SIGINT', handler('SIGINT'));
  process.on('SIGTERM', handler('SIGTERM'));
}

async function shutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'agent-connector shutting down');

  const watchdog = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'agent-connector shutdown watchdog fired — exiting hard');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  try {
    stopReclaimWorker();
    stopHeartbeat();
    // Signal the audit drain consumer to exit cleanly. Its loop blocks on
    // XREADGROUP for up to 5s, so the wait below is bounded.
    deps.auditDrainAbort.abort();
    await shutdownAllWorkers();
    const healthServer = deps.getHealthServer();
    if (healthServer) {
      await new Promise<void>((resolve) => {
        healthServer.close((err) => {
          if (err) logger.warn({ err }, 'healthServer.close reported an error');
          resolve();
        });
      });
    }
    logger.info('agent-connector shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown sequence');
  } finally {
    clearTimeout(watchdog);
    process.exit(0);
  }
}
