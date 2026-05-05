import express from 'express';
import fsp from 'fs/promises';
import { logger } from '@nova/shared';
import { DATA_ROOT } from '@nova/shared';
import { timedCheck, healthHandler } from '@nova/shared';
import { metricsHandler } from '@nova/shared';
import { getSharedRedis } from '@nova/shared';
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

app.listen(Number(PORT), () => {
  logger.info(`Gate Service health/metrics server on port ${PORT}`);
});
