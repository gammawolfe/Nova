// packages/agent-connector/src/index.ts
//
// Wiring & assembly: composes processTask + worker pool, audit drain,
// reclaim worker, heartbeat, health server, and shutdown handlers. The
// individual subsystems live in their own files so they can be imported
// (and tested) without firing side effects on module load.
//
// Importing this file is also side-effect-free — call `start()` to boot.
// bin.ts is the deployed entry point.

import type { Server } from 'http';
import { logger } from '@nova/shared/src/logger';
import { startAuditLogConsumer } from '@nova/shared/src/audit';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { initWorkerManager } from './worker-manager';
import { processTask } from './process-task';
import { startReclaimWorker } from './reclaim-worker';
import { startHeartbeat } from './heartbeat';
import { createHealthServer } from './health-server';
import { installShutdownHandlers } from './lifecycle';

export { processTask } from './process-task';
export { replyMetricOutcome } from './reply-metric';

export async function start(): Promise<void> {
  const startTime = Date.now();

  initWorkerManager(processTask).catch(err => {
    logger.error({ err }, 'Worker manager failed to boot');
    process.exit(1);
  });

  // The audit drain is the canonical consumer for nova:audit:stream — without
  // it, the stream accumulates in Redis forever and admin-api's audit queries
  // return empty. Agent-connector hosts it because it's the only long-running
  // service not on the HTTP request path. The abort controller is wired into
  // the shutdown sequence so XREADGROUP exits cleanly on SIGTERM.
  const auditDrainAbort = new AbortController();
  startAuditLogConsumer(DATA_ROOT, { signal: auditDrainAbort.signal })
    .catch(err => logger.error({ err }, 'Audit drain consumer crashed'));

  startReclaimWorker();
  startHeartbeat();

  let healthServer: Server | null = createHealthServer(startTime);

  installShutdownHandlers({
    auditDrainAbort,
    getHealthServer: () => healthServer,
  });
}
