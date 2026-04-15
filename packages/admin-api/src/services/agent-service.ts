import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT, TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';
import { getSharedRedis, closeSharedRedis } from '@nova/shared/src/redis';
import { ID_RE, validateId } from '@nova/shared/src/validation';
import { indexAgentMeta, deindexAgent, listActiveAgentMeta, getAgentMeta, ParsedAgentMeta, AGENT_LIFECYCLE_CHANNEL, AgentLifecycleEvent } from '@nova/shared/src/agent-index';

export { closeSharedRedis as closeRedis };
export type { ParsedAgentMeta };

export interface AgentConfig {
  agentId: string;
  tenantId: string;
  name: string;
  description?: string | undefined;
  version: string;
  operatorUrl?: string | undefined;
  skills: Array<{
    id: string; name: string; description: string;
    tags?: string[] | undefined;
    inputSchema?: Record<string, unknown> | undefined;
    outputSchema?: Record<string, unknown> | undefined;
  }>;
  highPrivilegeSkills: string[];
  confirmTimeouts: Record<string, number>;
  confirmWebhookUrl?: string | undefined;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  authentication: { schemes: string[]; ucapabilityPrefix: string };
  createdAt: string;
  status: 'pending' | 'active' | 'deregistered';
  // Self-registration fields (optional for backwards compat with pre-existing agents)
  did?: string | undefined;
  publicKey?: string | undefined;
  replyUrl?: string | undefined;
}

async function publishLifecycle(event: AgentLifecycleEvent): Promise<void> {
  await getSharedRedis().publish(AGENT_LIFECYCLE_CHANNEL, JSON.stringify(event));
}

function agentConfigPath(ctx: TenantContext): string {
  return tenantDataPath(ctx, 'agent-config.json');
}

export async function createAgent(tenantId: string, data: {
  agentId: string; name: string; description?: string | undefined; operatorUrl?: string | undefined;
  skills: AgentConfig['skills']; highPrivilegeSkills?: string[] | undefined;
  confirmTimeouts?: Record<string, number> | undefined; confirmWebhookUrl?: string | undefined;
}): Promise<AgentConfig> {
  validateId(tenantId, 'tenantId');
  validateId(data.agentId, 'agentId');
  const ctx: TenantContext = { tenantId, agentId: data.agentId };
  const agentDir = tenantDataPath(ctx);

  await Promise.all(
    ['trust-registry', 'quarantine', 'dead-letter', 'confirm-queue'].map(sub =>
      fsp.mkdir(path.join(agentDir, sub), { recursive: true })
    )
  );

  const config: AgentConfig = {
    agentId: data.agentId,
    tenantId,
    name: data.name,
    description: data.description,
    version: '1.0.0',
    operatorUrl: data.operatorUrl,
    skills: data.skills,
    highPrivilegeSkills: data.highPrivilegeSkills ?? [],
    confirmTimeouts: data.confirmTimeouts ?? {},
    confirmWebhookUrl: data.confirmWebhookUrl,
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    authentication: { schemes: ['ucan'], ucapabilityPrefix: `nova:${tenantId}:${data.agentId}` },
    createdAt: new Date().toISOString(),
    status: 'active',
  };

  await writeAtomicallyAsync(agentConfigPath(ctx), config);
  await indexAgentMeta(getSharedRedis(), config);
  await publishLifecycle({ action: 'created', tenantId, agentId: data.agentId, status: 'active' });
  return config;
}

/**
 * Create an agent in "pending" status via self-registration.
 * The agent is indexed in Redis (discoverable) but the gate pipeline
 * will quarantine its tasks until admin approval (DID not in trust registry).
 */
export async function createAgentPending(tenantId: string, data: {
  agentId: string; name: string; description?: string; operatorUrl?: string;
  skills: AgentConfig['skills']; did: string; publicKey: string; replyUrl: string;
}): Promise<AgentConfig> {
  validateId(tenantId, 'tenantId');
  validateId(data.agentId, 'agentId');
  const ctx: TenantContext = { tenantId, agentId: data.agentId };
  const agentDir = tenantDataPath(ctx);

  await Promise.all(
    ['trust-registry', 'quarantine', 'dead-letter', 'confirm-queue'].map(sub =>
      fsp.mkdir(path.join(agentDir, sub), { recursive: true })
    )
  );

  const config: AgentConfig = {
    agentId: data.agentId,
    tenantId,
    name: data.name,
    description: data.description,
    version: '1.0.0',
    operatorUrl: data.operatorUrl,
    skills: data.skills,
    highPrivilegeSkills: [],
    confirmTimeouts: {},
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    authentication: { schemes: ['ucan'], ucapabilityPrefix: `nova:${tenantId}:${data.agentId}` },
    createdAt: new Date().toISOString(),
    status: 'pending',
    did: data.did,
    publicKey: data.publicKey,
    replyUrl: data.replyUrl,
  };

  await writeAtomicallyAsync(agentConfigPath(ctx), config);
  await indexAgentMeta(getSharedRedis(), config);
  await publishLifecycle({ action: 'created', tenantId, agentId: data.agentId, status: 'pending' });
  return config;
}

/**
 * Approve a pending agent: flip status to active, return config for approval caller.
 */
export async function approveAgent(tenantId: string, agentId: string, notes?: string): Promise<AgentConfig> {
  validateId(tenantId, 'tenantId');
  validateId(agentId, 'agentId');
  const agent = await getAgent(tenantId, agentId);
  if (!agent) throw Object.assign(new Error(`Agent ${agentId} not found`), { status: 404 });
  if (agent.status === 'active') return agent;
  if (agent.status === 'deregistered') {
    throw Object.assign(new Error(`Agent ${agentId} is deregistered`), { status: 400 });
  }

  agent.status = 'active';
  const ctx: TenantContext = { tenantId, agentId };
  await writeAtomicallyAsync(agentConfigPath(ctx), agent);
  await indexAgentMeta(getSharedRedis(), agent);
  await publishLifecycle({ action: 'approved', tenantId, agentId, status: 'active' });
  return agent;
}

/**
 * Reject a pending agent: set status to deregistered, remove from Redis index.
 */
export async function rejectAgent(tenantId: string, agentId: string): Promise<boolean> {
  validateId(tenantId, 'tenantId');
  validateId(agentId, 'agentId');
  const agent = await getAgent(tenantId, agentId);
  if (!agent || agent.status !== 'pending') return false;
  agent.status = 'deregistered';
  const ctx: TenantContext = { tenantId, agentId };
  await writeAtomicallyAsync(agentConfigPath(ctx), agent);
  await deindexAgent(getSharedRedis(), agentId);
  await publishLifecycle({ action: 'deregistered', tenantId, agentId, status: 'deregistered' });
  return true;
}

export async function listAgents(tenantId: string): Promise<AgentConfig[]> {
  validateId(tenantId, 'tenantId');
  const agentsDir = path.join(DATA_ROOT, 'tenants', tenantId, 'agents');
  let dirs: string[];
  try { dirs = await fsp.readdir(agentsDir); }
  catch { return []; }

  const configs = await Promise.all(
    dirs
      .filter(d => ID_RE.test(d))
      .map(async d => {
        try {
          const raw = await fsp.readFile(path.join(agentsDir, d, 'agent-config.json'), 'utf8');
          return JSON.parse(raw) as AgentConfig;
        } catch { return null; }
      })
  );
  return configs.filter((a): a is AgentConfig => a !== null && a.status !== 'deregistered');
}

export async function getAgent(tenantId: string, agentId: string): Promise<AgentConfig | null> {
  validateId(tenantId, 'tenantId');
  validateId(agentId, 'agentId');
  try {
    const raw = await fsp.readFile(agentConfigPath({ tenantId, agentId }), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

/**
 * List all active agents from Redis discovery index.
 * Falls back to filesystem scan and populates Redis if the index is empty (migration).
 */
export async function listAllActiveAgents(): Promise<ParsedAgentMeta[]> {
  const redis = getSharedRedis();
  const fromRedis = await listActiveAgentMeta(redis);
  if (fromRedis.length > 0) return fromRedis;

  // Migration fallback: scan filesystem and populate Redis
  const tenantsDir = path.join(DATA_ROOT, 'tenants');
  let tenantDirs: string[];
  try { tenantDirs = await fsp.readdir(tenantsDir); }
  catch { return []; }

  const allAgents = await Promise.all(
    tenantDirs
      .filter(d => ID_RE.test(d))
      .map(async (tid) => listAgents(tid))
  );
  const active = allAgents.flat().filter(a => a.status === 'active');

  // Populate Redis as side-effect so future calls skip the filesystem
  await Promise.all(active.map(a => indexAgentMeta(redis, a)));

  return active.map(a => ({
    agentId: a.agentId,
    tenantId: a.tenantId,
    name: a.name,
    description: a.description ?? '',
    status: a.status,
    skills: a.skills.map(s => ({ id: s.id, name: s.name, description: s.description, tags: s.tags })),
    capabilities: a.capabilities,
  }));
}

/**
 * Get a single active agent's discovery metadata from Redis. O(1).
 * Falls back to filesystem if not in Redis.
 */
export async function getActiveAgent(agentId: string): Promise<ParsedAgentMeta | null> {
  const redis = getSharedRedis();
  const meta = await getAgentMeta(redis, agentId);
  if (meta && meta.status === 'active') return meta;

  // Fallback: check agent-index for tenantId, then read config from disk
  const tenantId = await redis.get(`nova:agent-index:${agentId}`);
  if (!tenantId) return null;

  const agent = await getAgent(tenantId, agentId);
  if (!agent || agent.status !== 'active') return null;

  // Populate Redis for future calls
  await indexAgentMeta(redis, agent);

  return {
    agentId: agent.agentId,
    tenantId: agent.tenantId,
    name: agent.name,
    description: agent.description ?? '',
    status: agent.status,
    skills: agent.skills.map(s => ({ id: s.id, name: s.name, description: s.description, tags: s.tags })),
    capabilities: agent.capabilities,
  };
}

export async function updateAgent(tenantId: string, agentId: string, updates: Partial<AgentConfig>): Promise<AgentConfig | null> {
  validateId(tenantId, 'tenantId');
  validateId(agentId, 'agentId');
  const config = await getAgent(tenantId, agentId);
  if (!config) return null;
  const updated = { ...config, ...updates };
  await writeAtomicallyAsync(agentConfigPath({ tenantId, agentId }), updated);
  await indexAgentMeta(getSharedRedis(), updated);
  return updated;
}

export async function deleteAgent(tenantId: string, agentId: string): Promise<boolean> {
  validateId(tenantId, 'tenantId');
  validateId(agentId, 'agentId');
  const config = await getAgent(tenantId, agentId);
  if (!config) return false;
  config.status = 'deregistered';
  await writeAtomicallyAsync(agentConfigPath({ tenantId, agentId }), config);
  await deindexAgent(getSharedRedis(), agentId);
  await publishLifecycle({ action: 'deregistered', tenantId, agentId, status: 'deregistered' });
  return true;
}
