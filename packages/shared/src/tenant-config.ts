import fsp from 'fs/promises';
import { NOVA_HOME, TENANT_CONFIG_PATH } from './paths.js';
import { parseInviteJwtPayload, ParseInvitePayloadOptions } from './invites.js';

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

/**
 * Decode an invite JWT's payload without verifying the signature. Used by
 * client-side flows (CLI inspect, MCP decode, broker-receiver init) that
 * need to read the invite's claims before deciding whether to commit local
 * state. Server-side flows must use `verifyInvite` from `./invites.js`,
 * which layers signature verification on top.
 *
 * Thin wrapper over `parseInviteJwtPayload` — kept here for source
 * compatibility with the broad caller surface (mcp-server, broker-receiver,
 * and this module itself).
 */
export function decodeInvitePayload(
  token: string,
  opts: ParseInvitePayloadOptions = {},
): { tenantId: string; agentIdHint?: string; exp: number; jti: string; expired?: boolean } {
  const parsed = parseInviteJwtPayload(token, opts);
  // Strip the `parts` helper — callers of the decode-only path don't need
  // the raw JWT segments.
  const { parts: _parts, ...payload } = parsed;
  return payload;
}
