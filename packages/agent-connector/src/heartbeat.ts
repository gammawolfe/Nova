// packages/agent-connector/src/heartbeat.ts
//
// Writes a TTL'd timestamp to Redis every 30s. The /health endpoint reads
// the same key and degrades the heartbeat check when the timestamp is
// older than 60s — useful for catching a wedged event loop that hasn't
// yet been noticed by Kubernetes / the load balancer.

import { logger } from '@nova/shared/src/logger';
import { getSharedRedis } from '@nova/shared/src/redis';

export const HEARTBEAT_KEY = 'nova:connector:heartbeat';
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TTL_SECONDS = 60;

let heartbeatInterval: NodeJS.Timeout | null = null;

export function startHeartbeat(): void {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(async () => {
    try {
      await getSharedRedis().set(HEARTBEAT_KEY, Date.now().toString(), 'EX', HEARTBEAT_TTL_SECONDS);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to write heartbeat');
    }
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}
