import fsp from 'fs/promises';
import { tenantDataPath, TenantContext } from '@nova/shared/src/tenant';

/**
 * Read the operator URL from the agent's config file.
 * This is the HTTP endpoint where the agent-connector delivers tasks for processing.
 */
export async function getOperatorUrl(ctx: TenantContext): Promise<string | null> {
  const configPath = tenantDataPath(ctx, 'agent-config.json');
  try {
    const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    return config.operatorUrl || null;
  } catch {
    return null;
  }
}
