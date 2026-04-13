import { Router } from 'express';
import fsp from 'fs/promises';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { timedCheck, healthHandler, HealthCheck } from '@nova/shared/src/health';
import { createMetricsRegistry, metricsHandler } from '@nova/shared/src/metrics';
import { getSharedRedis } from '@nova/shared/src/redis';

export const systemRouter = Router();
export const adminRegistry = createMetricsRegistry('admin-api');

const startTime = Date.now();

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

systemRouter.get('/health', healthHandler('admin-api', startTime, async () => {
  const [redis, data_dir, a2a_server, gate_service, agent_connector] = await Promise.all([
    timedCheck(async () => {
      const pong = await getSharedRedis().ping();
      if (pong !== 'PONG') throw new Error('Redis ping failed');
    }),
    timedCheck(async () => {
      await fsp.access(DATA_ROOT);
    }),
    fetchServiceHealth(process.env.A2A_HEALTH_URL || 'http://a2a-server:3001/health'),
    fetchServiceHealth(process.env.GATE_HEALTH_URL || 'http://gate-service:3002/health'),
    fetchServiceHealth(process.env.CONNECTOR_HEALTH_URL || 'http://agent-connector:3003/health'),
  ]);
  return { redis, data_dir, a2a_server, gate_service, agent_connector };
}) as any);

systemRouter.get('/metrics', metricsHandler(adminRegistry) as any);
