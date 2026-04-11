import fs from 'fs';
import { tenantDataPath } from '@nova/shared/src/tenant';
import { TenantContext } from '@nova/shared/src/tenant';
import { TaskRequestSchema } from '@nova/shared/src/schemas';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  parsedTask?: unknown;
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
export function validateSchema(rawTask: unknown, ctx: TenantContext): ValidationResult {
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

  // 3. Load agent config and verify intent is a known skill
  const configPath = tenantDataPath(ctx, 'agent-config.json');
  let agentConfig: AgentConfig;
  try {
    agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as AgentConfig;
  } catch {
    // Cannot read config — fail safe
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
