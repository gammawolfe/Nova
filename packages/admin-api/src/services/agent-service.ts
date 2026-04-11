import fsp from 'fs/promises';
import path from 'path';
import IORedis from 'ioredis';
import { DATA_ROOT, TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let redis: IORedis | null = null;
function getRedis(): IORedis {
  if (!redis) redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

const ID_RE = /^[a-z0-9_-]{1,64}$/;
function validateId(id: string, label = 'ID'): void {
  if (!ID_RE.test(id)) throw Object.assign(new Error(`Invalid ${label} format`), { status: 400 });
}

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
  status: 'active' | 'deregistered';
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
  await getRedis().set(`nova:agent-index:${data.agentId}`, tenantId);
  return config;
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

export async function updateAgent(tenantId: string, agentId: string, updates: Partial<AgentConfig>): Promise<AgentConfig | null> {
  validateId(tenantId, 'tenantId');
  validateId(agentId, 'agentId');
  const config = await getAgent(tenantId, agentId);
  if (!config) return null;
  const updated = { ...config, ...updates };
  await writeAtomicallyAsync(agentConfigPath({ tenantId, agentId }), updated);
  return updated;
}

export async function deleteAgent(tenantId: string, agentId: string): Promise<boolean> {
  validateId(tenantId, 'tenantId');
  validateId(agentId, 'agentId');
  const config = await getAgent(tenantId, agentId);
  if (!config) return false;
  config.status = 'deregistered';
  await writeAtomicallyAsync(agentConfigPath({ tenantId, agentId }), config);
  await getRedis().del(`nova:agent-index:${agentId}`);
  return true;
}
