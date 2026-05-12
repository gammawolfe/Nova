import fsp from 'fs/promises';
import { tenantDataPath } from '@nova/shared/src/tenant';
import { TenantContext } from '@nova/shared/src/tenant';
import { TaskRequestSchema } from '@nova/shared/src/schemas';
import type { TaskRequest } from '@nova/shared/src/types';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  /**
   * The parsed TaskRequest when validation succeeded. Typed precisely so
   * callers don't need to cast through `unknown`. Absent on failure.
   */
  parsedTask?: TaskRequest;
}

interface AgentSkill {
  id: string;
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

interface AgentConfig {
  skills: AgentSkill[];
  [key: string]: unknown;
}

// ── agent-config.json cache ─────────────────────────────────────────────────
//
// validateSchema runs on every ingress task and was reading
// `data/tenants/<tenantId>/agents/<agentId>/agent-config.json` from disk
// every time. Same hot-path concern as `task-queue/inbox.ts:isBrokerAgent`
// and resolved the same way: a 30-second in-process TTL keyed on
// (tenantId, agentId). Agent configs change rarely (admin-api update or
// approve), so 30s staleness is acceptable.
//
// The cache is intentionally process-scoped — a fresh gate-service process
// starts with an empty cache, the same way a deployment rollout would
// behave. For development convenience, callers that need cache eviction
// (e.g. tests, or admin-api after an update) can call
// `invalidateAgentConfigCache`.

const AGENT_CONFIG_TTL_MS = 30_000;

interface ConfigCacheEntry {
  config: AgentConfig;
  expiresAt: number;
}

const agentConfigCache = new Map<string, ConfigCacheEntry>();

function configCacheKey(ctx: TenantContext): string {
  return `${ctx.tenantId}:${ctx.agentId}`;
}

/**
 * Load and cache the agent-config.json for a (tenant, agent). On cache hit
 * within TTL, returns the in-memory copy without touching disk. On miss
 * or expiry, reads + parses + caches. Returns null when the file is
 * absent or malformed — caller decides how to treat that.
 */
async function loadAgentConfig(ctx: TenantContext): Promise<AgentConfig | null> {
  const key = configCacheKey(ctx);
  const cached = agentConfigCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const configPath = tenantDataPath(ctx, 'agent-config.json');
  try {
    const config = JSON.parse(await fsp.readFile(configPath, 'utf8')) as AgentConfig;
    agentConfigCache.set(key, { config, expiresAt: Date.now() + AGENT_CONFIG_TTL_MS });
    return config;
  } catch {
    return null;
  }
}

/**
 * Force-evict a (tenant, agent)'s config cache entry. Public so admin-api
 * can call it after an agent update if it shares a process with the gate
 * (it doesn't today, but the seam is cheap and removes a foot-gun).
 */
export function invalidateAgentConfigCache(ctx: TenantContext): void {
  agentConfigCache.delete(configCacheKey(ctx));
}

/**
 * Step 4 — Schema Validation.
 *
 * Validates:
 * 1. Top-level TaskRequest structure (Zod)
 * 2. Intent must map to a declared skill on this agent
 * 3. TTL must be in the future
 *
 * Note: Per-skill params JSON Schema validation is a best-effort check using
 * the JSON Schema stored in agent-config.json. Full Ajv validation is M3.
 *
 * Schema failures → DROP (not quarantine) — these are sender bugs.
 */
export async function validateSchema(rawTask: unknown, ctx: TenantContext): Promise<ValidationResult> {
  // 1. Top-level Zod validation
  const topLevel = TaskRequestSchema.safeParse(rawTask);
  if (!topLevel.success) {
    const firstPath = topLevel.error.issues[0]?.path.join('.') || 'unknown';
    return { valid: false, reason: `schema_invalid:${firstPath}` };
  }

  const task = topLevel.data;

  // 2. TTL must be in the future
  if (new Date(task.ttl) <= new Date()) {
    return { valid: false, reason: 'task_ttl_expired_at_ingress' };
  }

  // 3. Load agent config (cached, 30s TTL) and verify intent is a known skill
  const agentConfig = await loadAgentConfig(ctx);
  if (!agentConfig) {
    return { valid: false, reason: 'schema_invalid:agent_config_unavailable' };
  }

  const skill = agentConfig.skills?.find((s: AgentSkill) => s.id === task.intent);
  if (!skill) {
    return { valid: false, reason: 'intent_unknown' };
  }

  // 4. Basic required-field check against skill's inputSchema (full Ajv in M3)
  const required = (skill.inputSchema?.required as string[] | undefined) ?? [];
  for (const field of required) {
    if (task.params[field] === undefined) {
      return { valid: false, reason: `schema_invalid:params.${field}_required` };
    }
  }

  return { valid: true, parsedTask: task };
}
