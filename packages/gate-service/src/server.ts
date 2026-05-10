import express from 'express';
import fsp from 'fs/promises';
import { logger } from '@nova/shared/src/logger';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { timedCheck, healthHandler } from '@nova/shared/src/health';
import { metricsHandler } from '@nova/shared/src/metrics';
import { getSharedRedis, closeSharedRedis } from '@nova/shared/src/redis';
import { gateRegistry } from './metrics';

const app = express();
const PORT = process.env.GATE_PORT || 3002;
const startTime = Date.now();

let lastAnthropicCheck: { time: number; ok: boolean } = { time: 0, ok: true };

app.get('/health', (healthHandler('gate-service', startTime, async () => {
  const [redis, data_dir, anthropic_api] = await Promise.all([
    timedCheck(async () => {
      const pong = await getSharedRedis().ping();
      if (pong !== 'PONG') throw new Error('Redis ping failed');
    }),
    timedCheck(async () => {
      await fsp.access(DATA_ROOT);
    }),
    timedCheck(async () => {
      if (Date.now() - lastAnthropicCheck.time < 60_000) {
        if (!lastAnthropicCheck.ok) throw new Error('Anthropic API unhealthy (cached)');
        return;
      }
      const hasKey = !!process.env.ANTHROPIC_API_KEY;
      lastAnthropicCheck = { time: Date.now(), ok: hasKey };
      if (!hasKey) throw new Error('ANTHROPIC_API_KEY not configured');
    }),
  ]);
  return { redis, data_dir, anthropic_api };
})) as any);

app.get('/metrics', metricsHandler(gateRegistry) as any);

const httpServer = app.listen(Number(PORT), () => {
  logger.info(`Gate Service health/metrics server on port ${PORT}`);
});

// Graceful shutdown: stop accepting new connections, close Redis, exit. A
// watchdog timer guarantees the process exits even if `server.close` hangs
// on a stuck keep-alive. Idempotent — repeated signals are no-ops.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.NOVA_SHUTDOWN_TIMEOUT_MS ?? '15000', 10);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'gate-service shutting down');

  const watchdog = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'gate-service shutdown watchdog fired — exiting hard');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  try {
    await new Promise<void>((resolve) => {
      httpServer.close((err) => {
        if (err) logger.warn({ err }, 'server.close reported an error');
        resolve();
      });
    });
    await closeSharedRedis();
    logger.info('gate-service shutdown complete');
  } catch (err) {
    logger.error({ err }, 'Error during shutdown sequence');
  } finally {
    clearTimeout(watchdog);
    process.exit(0);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
