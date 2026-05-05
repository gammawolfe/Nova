import fsp from 'fs/promises';
import { tenantDataPath, TenantContext } from '@nova/shared';

const CONFIG_TTL_MS = 30_000; // 30 seconds
const configCache = new Map<string, { config: Record<string, unknown>; expiresAt: number }>();

/**
 * Load the agent config with a 30-second TTL cache.
 * Config changes (via admin-api) are rare; re-reads within the same task
 * processing cycle always hit cache, eliminating 2-3 redundant disk reads per task.
 */
export async function getAgentConfig(ctx: TenantContext): Promise<Record<string, unknown> | null> {
  const key = `${ctx.tenantId}:${ctx.agentId}`;
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const configPath = tenantDataPath(ctx, 'agent-config.json');
  try {
    const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    configCache.set(key, { config, expiresAt: Date.now() + CONFIG_TTL_MS });
    return config;
  } catch {
    return null;
  }
}

/**
 * Read the operator URL from the agent's config (cached).
 */
export async function getOperatorUrl(ctx: TenantContext): Promise<string | null> {
  const config = await getAgentConfig(ctx);
  return (config?.operatorUrl as string) || null;
}

/**
 * Force-evict a cached config entry. Call this if the connector
 * needs a fresh read (e.g. after an admin update notification).
 */
export function invalidateConfigCache(ctx: TenantContext): void {
  configCache.delete(`${ctx.tenantId}:${ctx.agentId}`);
}
