// packages/agent-connector/src/health-server.ts
//
// Express app for /health and /metrics. Listens on HEALTH_PORT.

import type { Server } from 'http';
import express from 'express';
import { logger } from '@nova/shared/src/logger';
import { timedCheck, healthHandler } from '@nova/shared/src/health';
import { metricsHandler } from '@nova/shared/src/metrics';
import { getSharedRedis } from '@nova/shared/src/redis';
import { connectorRegistry } from './metrics';
import { HEARTBEAT_KEY } from './heartbeat';

const DEFAULT_HEALTH_PORT = 3003;

export function getHealthPort(): number {
  const raw = process.env.HEALTH_PORT;
  if (!raw) return DEFAULT_HEALTH_PORT;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HEALTH_PORT;
}

export function createHealthServer(startTime: number): Server {
  const app = express();

  app.get('/health', healthHandler('agent-connector', startTime, async () => {
    const redis = getSharedRedis();
    const [redisCheck, heartbeatCheck] = await Promise.all([
      timedCheck(async () => {
        const pong = await redis.ping();
        if (pong !== 'PONG') throw new Error('Redis ping failed');
      }),
      timedCheck(async () => {
        const ts = await redis.get(HEARTBEAT_KEY);
        if (!ts) return;
        const age = Date.now() - parseInt(ts, 10);
        if (age > 60_000) throw new Error(`Heartbeat stale: ${age}ms`);
      }),
    ]);
    return { redis: redisCheck, heartbeat: heartbeatCheck };
  }) as any);

  app.get('/metrics', metricsHandler(connectorRegistry));

  const port = getHealthPort();
  const server = app.listen(port, () => {
    logger.info(`Agent Connector health/metrics on port ${port}`);
  });
  return server;
}
