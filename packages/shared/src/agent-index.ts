import IORedis from 'ioredis';

export const AGENT_REGISTRY_SET = 'nova:agent-registry';
export const AGENT_LIFECYCLE_CHANNEL = 'nova:agent-lifecycle';
export const TENANT_LIFECYCLE_CHANNEL = 'nova:tenant-lifecycle';
export const TASK_LIFECYCLE_CHANNEL = 'nova:task-lifecycle';

export interface TenantLifecycleEvent {
  action: 'created' | 'updated' | 'deleted';
  tenantId: string;
  slug: string;
  name: string;
}

export interface TaskLifecycleEvent {
  action: 'queued' | 'completed' | 'failed' | 'quarantined';
  taskId: string;
  toTenantId: string;
  toAgentId: string;
  fromTenantId?: string;
  fromAgentId?: string;
}

export function agentIndexKey(agentId: string): string {
  return `nova:agent-index:${agentId}`;
}

export function agentMetaKey(agentId: string): string {
  return `nova:agent-meta:${agentId}`;
}

export function didIndexKey(did: string): string {
  return `nova:did-index:${did}`;
}

/** Public discovery metadata stored in a Redis Hash per agent. */
export interface AgentMeta {
  agentId: string;
  tenantId: string;
  name: string;
  description: string;
  status: string;
  skills: string;        // JSON-serialized
  capabilities: string;  // JSON-serialized
  did: string;           // Empty string if legacy data pre-DID-index
}

export interface AgentLifecycleEvent {
  action: 'created' | 'approved' | 'deregistered';
  tenantId: string;
  agentId: string;
  status: string;
}

/**
 * Index an agent's public discovery metadata in Redis.
 * Called on create, approve, and update.
 */
export async function indexAgentMeta(
  redis: IORedis,
  config: {
    agentId: string;
    tenantId: string;
    name: string;
    description?: string | undefined;
    status: string;
    skills: Array<{ id: string; name: string; description: string; tags?: string[] | undefined; [key: string]: unknown }>;
    capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
    did?: string | undefined;
  }
): Promise<void> {
  const did = config.did ?? '';
  const pipe = redis.pipeline()
    .set(agentIndexKey(config.agentId), config.tenantId)
    .hset(agentMetaKey(config.agentId), {
      agentId: config.agentId,
      tenantId: config.tenantId,
      name: config.name,
      description: config.description ?? '',
      status: config.status,
      skills: JSON.stringify(config.skills),
      capabilities: JSON.stringify(config.capabilities),
      did,
    })
    .sadd(AGENT_REGISTRY_SET, config.agentId);
  if (did) pipe.set(didIndexKey(did), config.agentId);
  await pipe.exec();
}

/**
 * Remove an agent from the discovery index.
 * Called on reject and delete — updates status in Hash and removes from registry Set.
 */
export async function deindexAgent(redis: IORedis, agentId: string): Promise<void> {
  const did = await redis.hget(agentMetaKey(agentId), 'did');
  const pipe = redis.pipeline()
    .hset(agentMetaKey(agentId), 'status', 'deregistered')
    .srem(AGENT_REGISTRY_SET, agentId)
    .del(agentIndexKey(agentId));
  if (did) pipe.del(didIndexKey(did));
  await pipe.exec();
}

/** Parsed agent metadata for discovery responses. */
export interface ParsedAgentMeta {
  agentId: string;
  tenantId: string;
  name: string;
  description: string;
  status: string;
  skills: Array<{ id: string; name: string; description: string; tags?: string[] | undefined }>;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  did?: string | undefined;
}

function parseAgentMeta(data: Record<string, string>): ParsedAgentMeta | null {
  if (!data['agentId']) return null;
  try {
    return {
      agentId: data['agentId']!,
      tenantId: data['tenantId']!,
      name: data['name']!,
      description: data['description'] ?? '',
      status: data['status']!,
      skills: JSON.parse(data['skills'] || '[]'),
      capabilities: JSON.parse(data['capabilities'] || '{}'),
      did: data['did'] || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Get a single agent's discovery metadata from Redis. O(1).
 */
export async function getAgentMeta(redis: IORedis, agentId: string): Promise<ParsedAgentMeta | null> {
  const data = await redis.hgetall(agentMetaKey(agentId));
  return parseAgentMeta(data);
}

export async function getAgentByDid(redis: IORedis, did: string): Promise<ParsedAgentMeta | null> {
  if (!did) return null;
  const agentId = await redis.get(didIndexKey(did));
  if (!agentId) return null;
  return getAgentMeta(redis, agentId);
}

/**
 * List all active agents from Redis. O(A) pipelined.
 * Falls back to empty array if the registry is empty (caller should handle migration).
 */
export async function listActiveAgentMeta(redis: IORedis): Promise<ParsedAgentMeta[]> {
  const agentIds = await redis.smembers(AGENT_REGISTRY_SET);
  if (agentIds.length === 0) return [];

  const pipe = redis.pipeline();
  for (const id of agentIds) pipe.hgetall(agentMetaKey(id));
  const results = await pipe.exec();
  if (!results) return [];

  const agents: ParsedAgentMeta[] = [];
  for (const [err, data] of results) {
    if (err) continue;
    const parsed = parseAgentMeta(data as Record<string, string>);
    if (parsed && parsed.status === 'active') agents.push(parsed);
  }
  return agents;
}
