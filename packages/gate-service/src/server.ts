import express from 'express';
import fs from 'fs';
import IORedis from 'ioredis';
import { logger } from '@nova/shared/src/logger';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { timedCheck, aggregateHealth, HealthResponse } from '@nova/shared/src/health';
import { gateRegistry } from './metrics';

const app = express();
const PORT = process.env.GATE_PORT || 3002;
const startTime = Date.now();

let redis: IORedis | null = null;
function getRedis(): IORedis {
  if (!redis) {
    redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  }
  return redis;
}

let lastAnthropicCheck: { time: number; ok: boolean } = { time: 0, ok: true };

app.get('/health', (_req, res) => {
  (async () => {
    const checks = {
      redis: await timedCheck(async () => {
        const pong = await getRedis().ping();
        if (pong !== 'PONG') throw new Error('Redis ping failed');
      }),
      data_dir: await timedCheck(async () => {
        fs.accessSync(DATA_ROOT, fs.constants.R_OK);
      }),
      anthropic_api: await timedCheck(async () => {
        if (Date.now() - lastAnthropicCheck.time < 60_000) {
          if (!lastAnthropicCheck.ok) throw new Error('Anthropic API unhealthy (cached)');
          return;
        }
        const hasKey = !!process.env.ANTHROPIC_API_KEY;
        lastAnthropicCheck = { time: Date.now(), ok: hasKey };
        if (!hasKey) throw new Error('ANTHROPIC_API_KEY not configured');
      }),
    };
    const status = aggregateHealth(checks);
    const response: HealthResponse = {
      status, service: 'gate-service',
      uptime: Math.floor((Date.now() - startTime) / 1000), checks,
    };
    res.status(status === 'down' ? 503 : 200).json(response);
  })().catch(() => res.status(503).json({ status: 'down', service: 'gate-service' }));
});

app.get('/metrics', (_req, res) => {
  gateRegistry.metrics().then(metrics => {
    res.set('Content-Type', gateRegistry.contentType);
    res.end(metrics);
  }).catch(() => res.status(500).end('Error collecting metrics'));
});

app.listen(Number(PORT), () => {
  logger.info(`Gate Service health/metrics server on port ${PORT}`);
});
