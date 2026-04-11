import path from 'path';

/**
 * Interface defining a tenant organization within Nova.
 */
export interface Tenant {
  id: string; // UUID, assigned by Nova on registration
  name: string; // Human-readable name
  slug: string; // URL-safe identifier — used in paths and namespacing
  createdAt: string; // ISO 8601
  status: 'active' | 'suspended' | 'deleted';
  plan: 'developer' | 'pro' | 'enterprise';
  quotas: TenantQuotas;
}

export interface TenantQuotas {
  messagesPerDay: number; // -1 for unlimited
  agentsMax: number;
  trustedSendersMax: number;
}

/**
 * Context defining an isolated workload scope for a specific agent belonging to a specific tenant.
 */
export interface TenantContext {
  tenantId: string;
  agentId: string;
}

/**
 * Centralized utility to ensure all Redis keys are securely namespaced per isolate.
 */
export function redisKey(ctx: TenantContext, ...parts: string[]): string {
  return `t:${ctx.tenantId}:a:${ctx.agentId}:${parts.join(':')}`;
}

const DATA_ROOT = process.env.DATA_ROOT || path.join(process.cwd(), 'data');

/**
 * Centralized utility to ensure all file-system paths are securely directed per isolate.
 */
export function tenantDataPath(ctx: TenantContext, ...parts: string[]): string {
  return path.join(
    DATA_ROOT,
    'tenants',
    ctx.tenantId,
    'agents',
    ctx.agentId,
    ...parts
  );
}

/**
 * Generates the standardized BullMQ queue name for a specific TrustTier per isolate.
 */
export function queueName(ctx: TenantContext, tier: number): string {
  return `nova:t:${ctx.tenantId}:a:${ctx.agentId}:tasks:tier${tier}`;
}
