import { NovaClient } from './nova-client.js';
import { loadTenantConfig } from './tenant-config.js';
import { loadIdentity } from './identity.js';

export interface AgentRuntime {
  agentId: string;
  novaUrl: string;
  adminUrl?: string;
  adminToken?: string;
  client: NovaClient;
}

/**
 * Resolve the active agent identity + Nova connection from environment.
 *
 * Each MCP client (Claude Code, Hermes, OpenClaw, ...) sets NOVA_AGENT_ID in its
 * config, pointing the same mcp-server binary at a different local identity file.
 */
export async function loadAgentRuntime(): Promise<AgentRuntime | null> {
  const agentId = process.env['NOVA_AGENT_ID'];
  if (!agentId) return null;

  const identity = await loadIdentity(agentId);
  if (!identity) return null;

  const tenant = await loadTenantConfig();
  if (!tenant) return null;

  const novaUrl = process.env['NOVA_URL'] || tenant.novaUrl;
  const adminUrl = process.env['NOVA_ADMIN_URL'];
  const adminToken = process.env['NOVA_ADMIN_TOKEN'];

  return {
    agentId,
    novaUrl,
    ...(adminUrl ? { adminUrl } : {}),
    ...(adminToken ? { adminToken } : {}),
    client: new NovaClient({
      novaUrl,
      ...(adminUrl ? { adminUrl } : {}),
      ...(adminToken ? { adminToken } : {}),
    }),
  };
}

/** Variant for bootstrap tools (generate_identity, accept_invite) that run before runtime exists. */
export function bootstrapClient(novaUrl?: string, adminUrl?: string, adminToken?: string): NovaClient {
  const base = novaUrl || process.env['NOVA_URL'];
  if (!base) throw new Error('NOVA_URL env var or novaUrl argument required');
  return new NovaClient({
    novaUrl: base,
    ...(adminUrl || process.env['NOVA_ADMIN_URL'] ? { adminUrl: adminUrl || process.env['NOVA_ADMIN_URL']! } : {}),
    ...(adminToken || process.env['NOVA_ADMIN_TOKEN'] ? { adminToken: adminToken || process.env['NOVA_ADMIN_TOKEN']! } : {}),
  });
}
