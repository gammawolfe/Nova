import os from 'os';
import path from 'path';

export const NOVA_HOME = process.env['NOVA_HOME'] || path.join(os.homedir(), '.nova');
export const TENANT_CONFIG_PATH = path.join(NOVA_HOME, 'tenant.json');
export const AGENTS_DIR = path.join(NOVA_HOME, 'agents');

export function agentIdentityPath(agentId: string): string {
  return path.join(AGENTS_DIR, `${agentId}.json`);
}
