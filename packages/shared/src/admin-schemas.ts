import { z } from 'zod';

// ── Pagination ──────────────────────────────────────────────────────────────

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Tenants ─────────────────────────────────────────────────────────────────

export const TenantCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(64),
  plan: z.enum(['developer', 'pro', 'enterprise']).default('developer'),
  quotas: z.object({
    messagesPerDay: z.number().int().min(-1).default(1000),
    agentsMax: z.number().int().min(1).default(5),
    trustedSendersMax: z.number().int().min(1).default(50),
  }).optional(),
});

export const TenantUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  plan: z.enum(['developer', 'pro', 'enterprise']).optional(),
  quotas: z.object({
    messagesPerDay: z.number().int().min(-1).optional(),
    agentsMax: z.number().int().min(1).optional(),
    trustedSendersMax: z.number().int().min(1).optional(),
  }).optional(),
});

// ── Agents ──────────────────────────────────────────────────────────────────

export const SkillDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).optional(),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
});

export const AgentCreateSchema = z.object({
  agentId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  operatorUrl: z.string().url().optional(),
  skills: z.array(SkillDefinitionSchema).min(1),
  highPrivilegeSkills: z.array(z.string()).default([]),
  confirmTimeouts: z.record(z.number().int().min(1)).default({}),
  confirmWebhookUrl: z.string().url().optional(),
});

export const AgentUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  operatorUrl: z.string().url().optional(),
  skills: z.array(SkillDefinitionSchema).optional(),
  highPrivilegeSkills: z.array(z.string()).optional(),
  confirmTimeouts: z.record(z.number().int().min(1)).optional(),
  confirmWebhookUrl: z.string().url().optional(),
});

// ── Trust Registry ──────────────────────────────────────────────────────────

export const TrustActorAddSchema = z.object({
  did: z.string().startsWith('did:'),
  displayName: z.string().min(1).max(200),
  tier: z.number().int().min(1).max(3),
  allowedSkills: z.array(z.string()).min(1),
  notes: z.string().max(500).optional(),
});

export const TrustActorUpdateTierSchema = z.object({
  tier: z.number().int().min(0).max(3),
});

// ── UCAN ────────────────────────────────────────────────────────────────────

export const UcanIssueSchema = z.object({
  subjectDid: z.string().startsWith('did:'),
  capabilities: z.array(z.string()).min(1),
  expiryDays: z.number().int().min(1).max(365).default(30),
});

export const UcanRevokeSchema = z.object({
  cid: z.string().min(1),
});

// ── Confirmation ────────────────────────────────────────────────────────────

export const ConfirmApproveSchema = z.object({
  reviewedBy: z.string().min(1).default('admin'),
});

// ── Audit ───────────────────────────────────────────────────────────────────

export const AuditQuerySchema = z.object({
  event: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  taskId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
