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
  description: z.string().min(1).max(1000),
  operatorUrl: z.string().url().optional(),
  skills: z.array(SkillDefinitionSchema).min(1),
  highPrivilegeSkills: z.array(z.string()).default([]),
  confirmTimeouts: z.record(z.number().int().min(1)).default({}),
  confirmWebhookUrl: z.string().url().optional(),
});

export const AgentUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(1000).optional(),
  operatorUrl: z.string().url().nullable().optional(),
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

// ── Self-Registration ───────────────────────────────────────────────────────

export const SelfRegisterSchema = z.object({
  invite: z.string().min(1),               // Signed JWT from POST /admin/tenants/:tenantId/invites
  agentId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
  publicKey: z.string().min(1),           // Ed25519 public key (base64)
  did: z.string().startsWith('did:'),      // did:key:z6Mk...
  operatorUrl: z.string().url().optional(),
  skills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string()).optional(),
    inputSchema: z.record(z.unknown()).optional(),
    outputSchema: z.record(z.unknown()).optional(),
  })).min(1),
  replyUrl: z.string().url().optional(),   // Optional webhook for approval; polling via /register/status works without it
});

// ── Tenant Invites ──────────────────────────────────────────────────────────

export const InviteCreateSchema = z.object({
  agentIdHint: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64),
  ttlSeconds: z.number().int().min(60).max(7 * 24 * 3600).default(24 * 3600),
  note: z.string().max(200).optional(),
});

// ── Agent Approval ──────────────────────────────────────────────────────────

export const AgentApprovalSchema = z.object({
  trustTier: z.number().int().min(1).max(3).default(1),
  ucanExpiryDays: z.number().int().min(1).max(365).default(30),
  allowedSkills: z.array(z.string()).min(1).default(['*']),
  notes: z.string().max(500).optional(),
});

// ── UCAN Renewal (Proof-of-Possession) ──────────────────────────────────────

export const UcanRenewSchema = z.object({
  did: z.string().startsWith('did:'),
  agentId: z.string().min(1).max(64),
  nonce: z.string().min(1),
  signature: z.string().min(1),
});

// ── UCAN Request — cross-destination (Proof-of-Possession) ──────────────────

export const UcanRequestSchema = z.object({
  did: z.string().startsWith('did:'),
  agentId: z.string().min(1).max(64),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  destTenantId: z.string().min(1).max(64),
  destAgentId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64),
  skills: z.array(z.string().min(1)).min(1),
  expiryDays: z.number().int().min(1).max(365).default(30),
});

// ── Discovery Query ────────────────────────────────────────────────────────

export const DiscoverQuerySchema = z.object({
  status: z.enum(['active', 'pending', 'all']).default('active'),
  agentId: z.string().min(1).max(64).optional(),
  skills: z.string().optional(),
});
