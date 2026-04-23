// packages/broker-receiver/src/run.ts
//
// Wire-together entry for the `run` subcommand. Resolves config → loads
// identity → builds client/dispatcher/claim-loop/health → starts, then
// the caller installs signal handlers for graceful shutdown.

import { loadIdentity } from '@nova/shared/src/identity.js';
import { mintSelfAuthToken } from '@nova/shared/src/ucan-mint.js';
import type { ReceiverConfig } from './config.js';
import { NovaBrokerClient } from './nova-client.js';
import { Dispatcher } from './dispatcher.js';
import { ClaimLoop } from './claim-loop.js';
import { HealthServer } from './health-server.js';
import { createHandler } from './handlers/index.js';
import { createLogger } from './logger.js';

export interface RunResult {
  stop: () => Promise<void>;
  claimLoop: ClaimLoop;
  dispatcher: Dispatcher;
  healthServer: HealthServer;
  healthPort: number;
}

/**
 * Start the daemon in-process. Callers receive a stop() handle that
 * performs the documented shutdown sequence:
 *   1. Stop the claim loop (no new tasks claimed; SSE + tick disabled).
 *   2. Drain the dispatcher within shutdownGraceSeconds.
 *   3. Stop the health server.
 *
 * Exposed as a function instead of a class so tests can spin up a full
 * daemon, drive it, and tear it down without process-level signals.
 */
export async function runDaemon(config: ReceiverConfig): Promise<RunResult> {
  const logger = createLogger(config.logLevel);
  const startedAt = new Date();

  const identity = await loadIdentity(config.agentId);
  if (!identity) {
    throw new Error(
      `No identity for '${config.agentId}'. Run 'broker-receiver init' or generate one via nova_generate_identity.`,
    );
  }

  const mintSelfUcan = () =>
    mintSelfAuthToken({ senderDid: identity.did, senderPrivateKeyPem: identity.privateKeyPem });

  const client = new NovaBrokerClient({ novaUrl: config.novaUrl });
  const handler = await createHandler(config);
  logger.info(
    {
      handler: handler.name,
      agentId: config.agentId,
      novaUrl: config.novaUrl,
      inboxStrategy: config.inboxStrategy,
      pollFallbackMs: config.pollFallbackMs,
    },
    'daemon starting',
  );

  const dispatcher = new Dispatcher({
    agentId: config.agentId,
    handler,
    client,
    mintSelfUcan,
    maxConcurrentTasks: config.maxConcurrentTasks,
    logger,
  });

  const claimLoop = new ClaimLoop({
    agentId: config.agentId,
    client,
    dispatcher,
    mintSelfUcan,
    novaUrl: config.novaUrl,
    inboxStrategy: config.inboxStrategy,
    pollFallbackMs: config.pollFallbackMs,
    logger,
  });

  const healthServer = new HealthServer({ config, claimLoop, dispatcher, startedAt });
  const healthPort = await healthServer.start();
  if (healthPort > 0) {
    logger.info({ port: healthPort }, 'health endpoint listening on 127.0.0.1');
  }

  claimLoop.start();

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({}, 'shutdown requested');
    await claimLoop.stop();
    await dispatcher.shutdown(config.shutdownGraceSeconds);
    await healthServer.stop();
    logger.info(
      { stats: { claimLoop: claimLoop.getStats(), dispatcher: dispatcher.getStats() } },
      'shutdown complete',
    );
  };

  return { stop, claimLoop, dispatcher, healthServer, healthPort };
}
