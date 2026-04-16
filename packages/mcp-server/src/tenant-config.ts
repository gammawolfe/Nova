import fsp from 'fs/promises';
import { NOVA_HOME, TENANT_CONFIG_PATH } from './paths.js';

export interface TenantConfig {
  novaUrl: string;
  tenantId: string;
  agentIdHint?: string;   // from invite, optional
  inviteJti?: string;     // bookkeeping: which invite minted this config
  joinedAt: string;
}

export async function loadTenantConfig(): Promise<TenantConfig | null> {
  try {
    const raw = await fsp.readFile(TENANT_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveTenantConfig(cfg: TenantConfig): Promise<void> {
  await fsp.mkdir(NOVA_HOME, { recursive: true, mode: 0o700 });
  const tmp = TENANT_CONFIG_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, TENANT_CONFIG_PATH);
}

export function decodeInvitePayload(token: string): { tenantId: string; agentIdHint?: string; exp: number; jti: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed invite token');
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  if (payload.typ !== 'invite') throw new Error('Not an invite token');
  if (!payload.tenantId || typeof payload.exp !== 'number') throw new Error('Invite missing claims');
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Invite expired');
  return payload;
}
