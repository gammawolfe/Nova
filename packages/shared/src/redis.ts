import IORedis from 'ioredis';
import { logger } from './logger';

export const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/**
 * Lazily-initialized singleton Redis connection.
 * Shared across all modules in the same process to avoid connection proliferation.
 *
 * The 'error' listener surfaces connection-level failures through the
 * structured logger. Without it, ioredis silently buffers errors and callers
 * see only "timeouts" — a stale DNS entry, a Redis restart, and a TLS
 * handshake failure all look identical to an application-level bug.
 */
let _sharedRedis: IORedis | null = null;

export function getSharedRedis(): IORedis {
  if (!_sharedRedis) {
    _sharedRedis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    _sharedRedis.on('error', (err) => {
      logger.error({ err, tag: 'redis-shared' }, 'shared redis connection error');
    });
  }
  return _sharedRedis;
}

export async function closeSharedRedis(): Promise<void> {
  if (_sharedRedis) {
    await _sharedRedis.quit();
    _sharedRedis = null;
  }
}
