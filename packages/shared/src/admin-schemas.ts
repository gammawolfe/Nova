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

// ── Federation ──────────────────────────────────────────────────────────────
//
// Federation grants are Nova-to-Nova delegations: a UCAN signed by this Nova
// with aud = a peer Nova's DID. The peer's users can then chain their own
// invocations through this grant when calling our agents, and our gate's
// chain walker verifies back to our signature.
//
// `peerDid` is restricted to `did:web:` or `did:key:` — the only DID methods
// Nova's verifier resolves. Accepting other methods would mint grants no
// peer can actually verify against.
//
// `scope` is a list of capability `with` strings the peer is delegated to
// authorize within. Each becomes `{ with, can: 'invoke' }` in the UCAN's
// `att`. Empty list is rejected — a federation grant that authorizes
// nothing is a foot-gun.

export const FederationGrantIssueSchema = z.object({
  peerDid: z.string().regex(/^did:(web|key):/, 'peerDid must be did:web: or did:key:'),
  scope: z.array(z.string().min(1)).min(1),
  expiryDays: z.number().int().min(1).max(365).default(30),
  note: z.string().max(500).optional(),
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
  // ── H17: Claim-secret commitment ────────────────────────────────────────
  // 32-byte SHA-256 hex digest of a client-generated 32-byte CSPRNG secret.
  // The secret itself is NEVER sent at registration. The client retains the
  // secret locally and presents it as a header on GET /register/status to
  // claim the post-approval UCAN grant. This binds grant pickup to proof of
  // possession of the registering client.
  //
  // Optional during the migration window — when omitted, status fetches
  // proceed unauthenticated (legacy behaviour). The flip to required is
  // gated by the server-side flag NOVA_REQUIRE_CLAIM_SECRET.
  claimCommitment: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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

// ── UCAN Reissue ────────────────────────────────────────────────────────────
//
// Operator recovery for the one-time UCAN claim. Default behaviour is a
// straight refresh — same claim-secret commitment, fresh JWT and TTL — so a
// running agent that already holds its secret picks up the new grant
// transparently on its next nova_check_registration call.
//
// `clearClaimCommitment: true` is the lost-secret escape hatch. It strips
// the stored commitment from the agent record so the next status fetch
// returns the grant without a secret presentation. Use only when the agent
// has *demonstrably* lost its claim secret (e.g. ~/.nova was wiped) and
// you've verified out-of-band that this is the legitimate operator. The
// reissue audit log captures who used it.

export const UcanReissueSchema = z.object({
  clearClaimCommitment: z.boolean().default(false),
  reason: z.string().max(500).optional(),
});

// ── Agent Key Rotation (Proof-of-Possession of OLD key) ────────────────────
//
// Signature MUST cover `${nonce}|${newDid}|${newPublicKey}` — binding the
// nonce to the specific new identity prevents an attacker who captures a
// rotation request in flight from replaying it with a different newPublicKey.

export const AgentRotateKeySchema = z.object({
  oldDid: z.string().startsWith('did:'),
  newDid: z.string().startsWith('did:'),
  newPublicKey: z.string().min(1),      // base64 raw 32-byte Ed25519
  nonce: z.string().min(1),
  signature: z.string().min(1),         // base64url Ed25519 signature from OLD private key
});

// ── Discovery Query ────────────────────────────────────────────────────────

export const DiscoverQuerySchema = z.object({
  status: z.enum(['active', 'pending', 'all']).default('active'),
  agentId: z.string().min(1).max(64).optional(),
  skills: z.string().optional(),
});
