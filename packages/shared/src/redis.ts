import IORedis from 'ioredis';

export const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/**
 * Lazily-initialized singleton Redis connection.
 * Shared across all modules in the same process to avoid connection proliferation.
 */
let _sharedRedis: IORedis | null = null;

export function getSharedRedis(): IORedis {
  if (!_sharedRedis) {
    _sharedRedis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  }
  return _sharedRedis;
}

export async function closeSharedRedis(): Promise<void> {
  if (_sharedRedis) {
    await _sharedRedis.quit();
    _sharedRedis = null;
  }
}
