import { Router } from 'express';
import fs from 'fs';
import IORedis from 'ioredis';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { timedCheck, aggregateHealth, HealthResponse, HealthCheck } from '@nova/shared/src/health';
import { createMetricsRegistry } from '@nova/shared/src/metrics';

export const systemRouter = Router();
export const adminRegistry = createMetricsRegistry('admin-api');

const startTime = Date.now();
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let redis: IORedis | null = null;
function getRedis(): IORedis {
  if (!redis) redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  return redis;
}

async function fetchServiceHealth(url: string): Promise<HealthCheck> {
  return timedCheck(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json() as any;
      if (body.status === 'down') throw new Error('Service is down');
    } finally {
      clearTimeout(timeout);
    }
  });
}

systemRouter.get('/health', (_req, res) => {
  (async () => {
    const checks: Record<string, HealthCheck> = {
      redis: await timedCheck(async () => {
        const pong = await getRedis().ping();
        if (pong !== 'PONG') throw new Error('Redis ping failed');
      }),
      data_dir: await timedCheck(async () => {
        fs.accessSync(DATA_ROOT, fs.constants.R_OK | fs.constants.W_OK);
      }),
      a2a_server: await fetchServiceHealth(process.env.A2A_HEALTH_URL || 'http://a2a-server:3001/health'),
      gate_service: await fetchServiceHealth(process.env.GATE_HEALTH_URL || 'http://gate-service:3002/health'),
      agent_connector: await fetchServiceHealth(process.env.CONNECTOR_HEALTH_URL || 'http://agent-connector:3003/health'),
    };

    const status = aggregateHealth(checks);
    const response: HealthResponse = {
      status, service: 'admin-api',
      uptime: Math.floor((Date.now() - startTime) / 1000), checks,
    };
    res.status(status === 'down' ? 503 : 200).json(response);
  })().catch(() => res.status(503).json({ status: 'down', service: 'admin-api' }));
});

systemRouter.get('/metrics', (_req, res) => {
  adminRegistry.metrics().then(metrics => {
    res.set('Content-Type', adminRegistry.contentType);
    res.end(metrics);
  }).catch(() => res.status(500).end('Error collecting metrics'));
});
