import fs from 'fs';
import { tenantDataPath, TenantContext } from '@nova/shared/src/tenant';

/**
 * Read the operator URL from the agent's config file.
 * This is the HTTP endpoint where the agent-connector delivers tasks for processing.
 */
export function getOperatorUrl(ctx: TenantContext): string | null {
  const configPath = tenantDataPath(ctx, 'agent-config.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.operatorUrl || null;
  } catch {
    return null;
  }
}
