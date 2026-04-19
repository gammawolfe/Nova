// packages/shared/src/broker-config.ts

/**
 * Broker (MCP-pull) receiver config.
 *
 * Values can be overridden via env vars for ops flexibility — tests should
 * use the defaults. Env overrides are read at module-load time; restart the
 * containing process to pick up changes.
 */

function readInt(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** How long a pulled task remains in-flight before reclaim. Default 5 min. */
export const BROKER_VISIBILITY_TIMEOUT_MS = readInt('BROKER_VISIBILITY_TIMEOUT_MS', 5 * 60 * 1000);

/** Reclaim ceiling — after N retries the task goes to DLQ. Default 3. */
export const BROKER_RECLAIM_CEILING = readInt('BROKER_RECLAIM_CEILING', 3);

/** Max seconds the server will hold a long-poll open. Client caps at this too. Default 60s. */
export const BROKER_MAX_WAIT_MS = readInt('BROKER_MAX_WAIT_MS', 60 * 1000);

/** How often the reclaim worker sweeps in-flight sets. Default 10s. */
export const BROKER_RECLAIM_INTERVAL_MS = readInt('BROKER_RECLAIM_INTERVAL_MS', 10 * 1000);
