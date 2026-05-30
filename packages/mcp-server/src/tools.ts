import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  generateIdentity,
  saveIdentity,
  loadIdentity,
  listAgentIds,
  sign,
} from '@nova/shared/src/identity.js';
import { loadTenantConfig, saveTenantConfig, decodeInvitePayload } from '@nova/shared/src/tenant-config.js';
import { loadAgentRuntime, bootstrapClient } from './context.js';
import {
  loadCache as loadUcanCache,
  saveCache as saveUcanCache,
  withCacheLock,
  remainingFraction,
  getGrantIfFresh,
} from '@nova/shared/src/ucan-store.js';
import { mintInvocationToken, mintSelfAuthToken } from '@nova/shared/src/ucan-mint.js';
import { generateClaimSecret, commitmentOf, CLAIM_SECRET_HEADER } from '@nova/shared/src/claim-secret.js';
import { agentIdentityPath } from '@nova/shared/src/paths.js';
import fsp from 'fs/promises';
import type { NovaClient } from './nova-client.js';
import type { SubscriptionManager } from './subscriptions.js';

type ToolResult =
  | { content: [{ type: 'text'; text: string }] }
  | { isError: true; content: [{ type: 'text'; text: string }] };

function ok(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function err(message: string): { isError: true; content: [{ type: 'text'; text: string }] } {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// ── forAction: per-action validation + dispatch ────────────────────────────
//
// The consolidated tools advertise a FLAT input schema (a required `action`
// enum plus every param marked optional) because that is the only shape the
// MCP SDK renders into a full JSON-Schema property list for the client — a
// top-level z.discriminatedUnion normalizes to an empty schema (see
// docs/mcp-tool-consolidation.md). We recover per-action safety here: each
// action re-parses the slice of args it actually needs against its own zod
// schema, so a wrong-shape call returns a precise error instead of reaching the
// handler with undefined fields.
async function forAction<T extends z.ZodTypeAny>(
  schema: T,
  args: unknown,
  fn: (v: z.infer<T>) => Promise<ToolResult> | ToolResult,
): Promise<ToolResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return err(`Invalid params for this action: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  return fn(parsed.data);
}

// ── nova_check_status cache ────────────────────────────────────────────────
//
// Process-local 5-minute cache of (agentId, cid) → health response. Keyed by
// cid so a UCAN rotation (which changes the cid) effectively invalidates the
// entry for free. Bounded purely by the MCP-server process lifetime; a fresh
// process starts with an empty cache, which is the right default for stdio
// transports that get spawned per session.

type HealthResponse = {
  agentId: string;
  agentStatus: 'active' | 'pending' | 'deregistered' | 'unknown';
  ucan?: { cid: string; revoked: boolean; found: boolean; expiresAt?: string };
};

const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;
const healthCache = new Map<string, { at: number; response: HealthResponse }>();

async function getHealth(
  client: NovaClient,
  agentId: string,
  ucanCid: string | undefined,
): Promise<HealthResponse> {
  const key = `${agentId}|${ucanCid ?? ''}`;
  const now = Date.now();
  const hit = healthCache.get(key);
  if (hit && now - hit.at < HEALTH_CACHE_TTL_MS) return hit.response;
  const response = await client.getAgentHealth(agentId, ucanCid);
  healthCache.set(key, { at: now, response });
  return response;
}

// ── Broker-mode context preamble ───────────────────────────────────────────
//
// The four broker pull/respond operations (inbox next/respond, reply next/ack)
// share an identical preamble: resolve the active runtime, load the identity,
// guard that a tenant is joined, and mint a self-auth UCAN. Extracted here so
// the guard logic lives in one place. Throws on any guard failure; callers
// convert to a tool-result error via a single try/catch wrapping only this
// call, which preserves the original error messages verbatim (the
// per-client-call try/catch that follows keeps its own "X failed:" prefix).
async function brokerCtx() {
  const rt = await loadAgentRuntime();
  if (!rt) throw new Error('No active agent runtime. Set NOVA_AGENT_ID.');
  const identity = await loadIdentity(rt.agentId);
  if (!identity) throw new Error(`Identity missing for ${rt.agentId}`);
  const tenant = await loadTenantConfig();
  if (!tenant) throw new Error('No tenant joined');
  const selfUcan = mintSelfAuthToken({
    senderDid: identity.did,
    senderPrivateKeyPem: identity.privateKeyPem,
  });
  return { rt, identity, tenant, selfUcan };
}

// ── Shared param schemas ───────────────────────────────────────────────────
//
// Single source of truth for the actions with rich/required params. Used both
// as the legacy tools' inputSchema (the SDK normalizes a ZodObject the same way
// it does a raw shape) and as the per-action validator inside forAction for the
// consolidated tools. Defining them once keeps the two surfaces in lockstep.

const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).optional(),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
});

const registerParamsSchema = z.object({
  agentId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64).describe('Must match an identity created via nova_generate_identity AND the agentIdHint claim in the invite JWT. Mismatches return AGENT_ID_MISMATCH but leave the invite reusable.'),
  name: z.string().min(1).max(200).describe('Human-readable agent name (displayed in admin UI / agent cards)'),
  description: z.string().min(1).max(1000).describe('Short description of what this agent does (required — appears on the public agent card).'),
  invite: z.string().min(1).describe('The invite JWT from the operator. Consumed only after server-side validation passes, so agent-side errors (mismatch, missing tenant, duplicate agent) leave it reusable. On successful 201, or on INVITE_INVALID, request a fresh token.'),
  skills: z.array(skillSchema).min(1).describe('Skills this agent accepts. Senders may use the special skill { id: "__sender_only", name: "Sender only", description: "This agent sends tasks only; it does not receive." }'),
  operatorUrl: z.string().url().optional().describe('HTTPS endpoint Nova will POST tasks to. Omit for sender-only agents.'),
  replyUrl: z.string().url().optional().describe('Webhook Nova calls with { event: "agent_approved", ucan, ... } on approval. Optional — polling via check_status works without it.'),
});
type RegisterParams = z.infer<typeof registerParamsSchema>;

const sendParamsSchema = z.object({
  targetAgentId: z.string().min(1).describe('Destination agent ID (from nova_discover list)'),
  intent: z.string().min(1).describe('Skill ID declared in the destination agent card'),
  params: z.record(z.unknown()).describe('Skill inputs; must validate against the destination\'s inputSchema'),
  ttlMinutes: z.number().int().min(1).max(1440).default(60),
  idempotencyKey: z.string().optional(),
  replyTo: z.string().url().optional().describe('Override replyTo URL (defaults to a discovery-time Nova reply slot)'),
});
type SendParams = z.infer<typeof sendParamsSchema>;

const respondParamsSchema = z.object({
  taskId: z.string().uuid().describe('The taskId returned by inbox next'),
  status: z.enum(['ok', 'error']).describe('"ok" on success, "error" on failure'),
  result: z.record(z.unknown()).optional().describe('On status="ok": the result payload shaped to the skill\'s outputSchema'),
  error: z.object({
    code: z.string().describe('Error code string'),
    message: z.string().describe('Human-readable error message'),
    retryable: z.boolean().optional().describe('Whether the sender should retry the task'),
  }).optional().describe('On status="error": structured error detail'),
}).refine((v) => v.status !== 'error' || !!v.error, {
  message: '`error` is required when status is "error"',
  path: ['error'],
});
type RespondParams = z.infer<typeof respondParamsSchema>;

const listParamsSchema = z.object({
  skills: z.string().optional().describe('Substring match against skill ID/name/tag'),
  status: z.enum(['active', 'pending', 'all']).default('active'),
});

// ── Operations (shared by the consolidated and legacy tool surfaces) ────────

async function opGenerateIdentity(agentId: string): Promise<ToolResult> {
  const existing = await loadIdentity(agentId);
  if (existing) return err(`Identity for agent '${agentId}' already exists. Use whoami to inspect it, or pick a different agentId.`);
  const identity = generateIdentity(agentId);
  await saveIdentity(identity);
  return ok({ agentId, did: identity.did, publicKey: identity.publicKey, createdAt: identity.createdAt });
}

async function opWhoami(): Promise<ToolResult> {
  const tenant = await loadTenantConfig();
  const agentIds = await listAgentIds();
  const active = process.env['NOVA_AGENT_ID'];
  const activeIdentity = active ? await loadIdentity(active) : null;
  let grantSummary: any = null;
  if (active && activeIdentity) {
    const cache = await loadUcanCache(active);
    grantSummary = cache.grant
      ? { expiresAt: cache.grant.expiresAt, lifetimeRemaining: remainingFraction(cache.grant) }
      : null;
  }
  return ok({
    activeAgentId: active ?? null,
    activeDid: activeIdentity?.did ?? null,
    tenant: tenant ?? null,
    allLocalAgents: agentIds,
    grant: grantSummary,
    env: {
      NOVA_URL: process.env['NOVA_URL'] ?? null,
      NOVA_AGENT_ID: active ?? null,
      NOVA_ADMIN_URL: process.env['NOVA_ADMIN_URL'] ?? null,
    },
  });
}

async function opRotateKey(agentId?: string): Promise<ToolResult> {
  const rt = await loadAgentRuntime();
  if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID and ensure identity + tenant are configured.');
  const resolved = agentId ?? rt.agentId;
  const tenant = await loadTenantConfig();
  if (!tenant) return err('No tenant joined');
  const old = await loadIdentity(resolved);
  if (!old) return err(`No identity for '${resolved}'`);

  // Generate the new keypair up front — if anything downstream fails,
  // the on-disk state is untouched.
  const fresh = generateIdentity(resolved);

  // PoP: sign (nonce | newDid | newPublicKey) with the OLD private key.
  // Binding all three prevents an attacker with transient control of the
  // request path from swapping in a newPublicKey of their own.
  const { nonce } = await rt.client.getNonce(tenant.tenantId, old.did, resolved);
  const signature = sign(old.privateKeyPem, `${nonce}|${fresh.did}|${fresh.publicKey}`);

  let result;
  try {
    result = await rt.client.rotateKey(tenant.tenantId, resolved, {
      oldDid: old.did,
      newDid: fresh.did,
      newPublicKey: fresh.publicKey,
      nonce,
      signature,
    });
  } catch (e: any) {
    return err(`Rotation failed: ${e.message}`);
  }

  // Commit local state under the cache lock so that a concurrent
  // send / grant_status on this agent can't observe a half-rotated state
  // (new identity on disk but old UCANs in cache).
  await withCacheLock(resolved, async () => {
    // Snapshot the pre-rotation identity to a timestamped backup so an
    // operator can reconstruct the old did if needed (incident review).
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = agentIdentityPath(resolved) + `.rotated-${ts}.bak`;
    try {
      await fsp.rename(agentIdentityPath(resolved), bakPath);
    } catch (e: any) {
      // If the identity file was already swapped out by a crashed prior
      // attempt, proceed with the save — we have the credentials we need.
      if (e.code !== 'ENOENT') throw e;
    }

    await saveIdentity({ ...fresh });

    // Reset the grant cache with the freshly-issued approval grant bound
    // to the new DID. Every invocation token now derives from this grant;
    // any stale in-flight invocation (rare, given 5-minute TTLs) would
    // fail the chain's aud check (grant.aud = newDid != old iss).
    await saveUcanCache({
      agentId: resolved,
      grant: { jwt: result!.jwt, cid: result!.cid, expiresAt: result!.expiresAt },
    });
  });

  return ok({
    status: 'rotated',
    agentId: resolved,
    oldDid: old.did,
    newDid: result.newDid,
    trustTier: result.trustTier,
    allowedSkills: result.allowedSkills,
    revokedCount: result.revokedCids.length,
    grantExpiresAt: result.expiresAt,
    note: 'If other tenants had this agent in their trust registry under the old DID, those entries are now stale and must be re-seeded with the new DID.',
  });
}

// Reports the locally-cached approval grant. In the delegation-chain model the
// grant is the only Nova-signed credential held client-side and there is no
// client-side renewal — `includeRenewal` surfaces that as structured output so
// the consolidated grant_status action carries the remediation an agent needs;
// the legacy nova_renew_ucan tool calls it without renewal to keep its original
// payload byte-for-byte.
async function opGrantStatus(includeRenewal: boolean): Promise<ToolResult> {
  const rt = await loadAgentRuntime();
  if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID and ensure identity + tenant are configured.');
  const grant = await getGrantIfFresh(rt.agentId, 0);
  if (!grant) return err('No grant cached locally. Run check_status after operator approval.');
  return ok({
    cid: grant.cid,
    expiresAt: grant.expiresAt,
    lifetimeRemaining: remainingFraction(grant),
    ...(includeRenewal
      ? {
          renewal: {
            mode: 'operator_reissue_required',
            remediation: "No client-side renewal in the delegation-chain model. When near expiry, the operator runs nova_admin({action:'reissue_grant', tenantId, agentId}), then this agent runs nova_onboard({action:'check_status'}) to pick up the fresh grant.",
          },
        }
      : {}),
  });
}

async function opUcanStatus(): Promise<ToolResult> {
  const active = process.env['NOVA_AGENT_ID'];
  if (!active) return err('NOVA_AGENT_ID not set');
  const cache = await loadUcanCache(active);
  return ok({
    grant: cache.grant
      ? { cid: cache.grant.cid, expiresAt: cache.grant.expiresAt, lifetimeRemaining: remainingFraction(cache.grant) }
      : null,
  });
}

async function opInspectInvite(invite: string): Promise<ToolResult> {
  let payload;
  try { payload = decodeInvitePayload(invite, { allowExpired: true }); }
  catch (e: any) { return err(`Invalid invite: ${e.message}`); }
  return ok({
    tenantId: payload.tenantId,
    agentIdHint: payload.agentIdHint ?? null,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    jti: payload.jti,
    expired: !!payload.expired,
  });
}

async function opAcceptInvite(invite: string, novaUrl?: string): Promise<ToolResult> {
  const resolvedUrl = novaUrl || process.env['NOVA_URL'];
  if (!resolvedUrl) return err('novaUrl argument or NOVA_URL env var is required');
  let payload;
  try { payload = decodeInvitePayload(invite); }
  catch (e: any) { return err(`Invalid invite: ${e.message}`); }
  // Verify signature and tenant existence server-side before overwriting
  // local state. Prevents stale or mistyped tokens from clobbering a
  // previously-valid tenant.json with unusable claims.
  const client = bootstrapClient(resolvedUrl);
  try {
    await client.verifyInvite(invite);
  } catch (e: any) {
    return err(`Invite verification failed against ${resolvedUrl}: ${e.message}`);
  }
  await saveTenantConfig({
    novaUrl: resolvedUrl,
    tenantId: payload.tenantId,
    ...(payload.agentIdHint ? { agentIdHint: payload.agentIdHint } : {}),
    inviteJti: payload.jti,
    joinedAt: new Date().toISOString(),
  });
  return ok({ status: 'tenant_joined', tenantId: payload.tenantId, agentIdHint: payload.agentIdHint, expiresAt: new Date(payload.exp * 1000).toISOString() });
}

async function opRegister(args: RegisterParams): Promise<ToolResult> {
  const tenant = await loadTenantConfig();
  if (!tenant) return err('No tenant joined. Run accept_invite first.');

  const identity = await loadIdentity(args.agentId);
  if (!identity) return err(`No identity for '${args.agentId}'. Run generate first.`);

  // H17 — generate a fresh claim secret, persist alongside the identity,
  // send only the commitment to the server. If a secret already exists
  // locally (re-run after a transient register failure), reuse it so the
  // server-side commitment stays consistent.
  let claimSecret: string;
  let claimCommitment: string;
  if (identity.claimSecret) {
    claimSecret = identity.claimSecret;
    claimCommitment = commitmentOf(claimSecret);
  } else {
    const fresh = generateClaimSecret();
    claimSecret = fresh.secret;
    claimCommitment = fresh.commitment;
    await saveIdentity({ ...identity, claimSecret });
  }

  const client = bootstrapClient(tenant.novaUrl);
  try {
    const result = await client.register({
      invite: args.invite,
      agentId: args.agentId,
      name: args.name,
      ...(args.description !== undefined ? { description: args.description } : {}),
      publicKey: identity.publicKey,
      did: identity.did,
      ...(args.operatorUrl !== undefined ? { operatorUrl: args.operatorUrl } : {}),
      skills: args.skills,
      ...(args.replyUrl !== undefined ? { replyUrl: args.replyUrl } : {}),
      claimCommitment,
    });
    return ok({
      status: result.status,
      tenantId: result.tenantId,
      agentId: result.agentId,
      statusUrl: result.statusUrl,
      nextStep: "Operator must approve via admin UI. Then call nova_onboard({action:'check_status'}) to claim the grant.",
    });
  } catch (e: any) {
    return err(`Registration failed: ${e.message}`);
  }
}

async function opCheckStatus(agentId?: string): Promise<ToolResult> {
  const tenant = await loadTenantConfig();
  if (!tenant) return err('No tenant joined. Run accept_invite first.');
  const resolvedAgentId = agentId ?? process.env['NOVA_AGENT_ID'];
  if (!resolvedAgentId) return err('agentId argument or NOVA_AGENT_ID env var required');
  const identity = await loadIdentity(resolvedAgentId);
  if (!identity) return err(`No identity for '${resolvedAgentId}'`);

  const client = bootstrapClient(tenant.novaUrl);
  const status = await client.registrationStatus(tenant.tenantId, resolvedAgentId, identity.claimSecret);

  // H17 — server tells us the claim has been locked after repeated
  // mismatches. The local secret is no longer authoritative; operator
  // must reissue.
  if (status.error === 'CLAIM_LOCKED') {
    return err(
      `CLAIM_LOCKED: Grant pickup for '${resolvedAgentId}' was locked by Nova after repeated claim-secret mismatches. ` +
      `Ask the operator to reissue the grant (nova_admin reissue_grant) with tenantId='${tenant.tenantId}' agentId='${resolvedAgentId}' (requires NOVA_ADMIN_TOKEN). ` +
      `If this happens repeatedly without operator intervention, your tenantId/agentId may be leaked — investigate before reissuing.`,
    );
  }

  if (status.status === 'active' && status.grant) {
    await withCacheLock(resolvedAgentId, async () => {
      const cache = await loadUcanCache(resolvedAgentId);
      cache.grant = {
        jwt: status.grant!.jwt,
        cid: status.grant!.cid,
        expiresAt: status.grant!.expiresAt,
      };
      await saveUcanCache(cache);
    });
    return ok({
      status: 'active',
      claimed: true,
      trustTier: status.grant.trustTier,
      grantExpiresAt: status.grant.expiresAt,
    });
  }

  // Status active, no grant in response. Either (a) the claim was already
  // consumed by a prior call and the local cache holds it, or (b) the
  // claim window expired before we polled. Disambiguate via local cache.
  if (status.status === 'active') {
    const cache = await loadUcanCache(resolvedAgentId);
    if (!cache.grant) {
      return err(
        `GRANT_CLAIM_EXPIRED: Agent '${resolvedAgentId}' is active, but the one-time grant claim is no longer available and no grant is cached locally. Ask the operator to reissue the grant (nova_admin reissue_grant) with tenantId='${tenant.tenantId}' agentId='${resolvedAgentId}' (requires NOVA_ADMIN_TOKEN), then call check_status again.`,
      );
    }
    return ok({
      status: 'active',
      claimed: false,
      note: 'Agent active; grant claim already consumed — using cached grant.',
      grantExpiresAt: cache.grant.expiresAt,
    });
  }

  return ok({ status: status.status, claimed: false });
}

async function opListAgents(args: z.infer<typeof listParamsSchema>): Promise<ToolResult> {
  const rt = await loadAgentRuntime();
  const client = rt?.client ?? bootstrapClient();
  const res = await client.listAgents({
    status: args.status,
    ...(args.skills !== undefined ? { skills: args.skills } : {}),
  });
  return ok(res);
}

async function opGetCard(agentId: string): Promise<ToolResult> {
  const rt = await loadAgentRuntime();
  const client = rt?.client ?? bootstrapClient();
  const res = await client.getAgentCard(agentId);
  return ok(res);
}

async function opSendTask(args: SendParams): Promise<ToolResult> {
  const rt = await loadAgentRuntime();
  if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID.');
  const identity = await loadIdentity(rt.agentId);
  if (!identity) return err(`Identity missing for ${rt.agentId}`);
  const tenant = await loadTenantConfig();
  if (!tenant) return err('No tenant joined');

  // Pre-flight: is THIS agent still active and is its grant still valid?
  // Cached for 5 min per (agentId, cid). Catches operator-driven grant
  // revocations that would otherwise quarantine the task at the gate with
  // no clear signal to the sender.
  const grant = await getGrantIfFresh(rt.agentId);
  try {
    const selfHealth = await getHealth(rt.client, rt.agentId, grant?.cid);
    if (selfHealth.agentStatus === 'deregistered') {
      return err(`AGENT_INACTIVE: this agent '${rt.agentId}' is deregistered in Nova. Contact the tenant operator — a fresh invite + registration is required before sending tasks.`);
    }
    if (selfHealth.agentStatus === 'pending') {
      return err(`AGENT_INACTIVE: this agent '${rt.agentId}' is still pending operator approval. Run check_status and wait for approval before sending tasks.`);
    }
    if (selfHealth.ucan?.revoked) {
      return err(`GRANT_REVOKED: this agent's approval grant (cid=${selfHealth.ucan.cid}) has been revoked. Ask the operator to reissue the grant and then call check_status to pick up the fresh grant.`);
    }
  } catch {
    // Advisory-only: don't block sends if the probe itself fails.
  }

  if (!grant) {
    return err(`GRANT_MISSING: no valid grant cached for '${rt.agentId}'. Run check_status (after operator approval) to claim it.`);
  }

  const target = await rt.client.getAgent(args.targetAgentId);
  const destTenantId: string | undefined = target?.tenantId;
  if (!destTenantId) return err(`Destination agent '${args.targetAgentId}' not found or has no tenantId`);
  if (target?.status && target.status !== 'active') {
    return err(`DEST_AGENT_INACTIVE: destination '${args.targetAgentId}' is ${target.status}. Pick a different target via nova_discover list or wait for the operator to approve it.`);
  }

  // Mint the invocation token locally — signed by THIS agent's Ed25519
  // private key, with the broad-scope approval grant carried as prf. 5m
  // TTL is the server-side default; long enough for queued retries, short
  // enough that a leaked token can't be replayed for long.
  const ucan = mintInvocationToken({
    senderDid: identity.did,
    senderPrivateKeyPem: identity.privateKeyPem,
    grantJwt: grant.jwt,
    scope: `nova:${destTenantId}:${args.targetAgentId}:skill:${args.intent}`,
  });

  const ttlMs = args.ttlMinutes * 60 * 1000;
  const payload: {
    id: string;
    schemaVersion: '1.0';
    intent: string;
    params: Record<string, unknown>;
    ttl: string;
    idempotencyKey: string;
    replyTo?: string;
  } = {
    id: randomUUID(),
    schemaVersion: '1.0' as const,
    intent: args.intent,
    params: args.params,
    ttl: new Date(Date.now() + ttlMs).toISOString(),
    idempotencyKey: args.idempotencyKey ?? randomUUID(),
  };
  // When the caller doesn't supply a replyTo, Nova routes the result to
  // this agent's broker reply inbox (GET /agents/:agentId/replies), keyed
  // by the sender's DID. Fetch via nova_replies next or nova_task result.
  if (args.replyTo) payload.replyTo = args.replyTo;
  const result = await rt.client.sendTask(args.targetAgentId, ucan, payload);
  return ok({
    ...(result as Record<string, unknown>),
    nextStep: "Collect the result via nova_task({action:'result', targetAgentId, taskId}) or nova_replies({action:'next'}).",
  });
}

async function opGetResult(targetAgentId: string, taskId: string): Promise<ToolResult> {
  const rt = await loadAgentRuntime();
  if (!rt) return err('No active agent runtime');
  const identity = await loadIdentity(rt.agentId);
  if (!identity) return err(`Identity missing for ${rt.agentId}`);
  const tenant = await loadTenantConfig();
  if (!tenant) return err('No tenant joined');

  // Prefer the broker reply inbox — returns the actual TaskResult payload.
  try {
    const selfUcan = mintSelfAuthToken({
      senderDid: identity.did,
      senderPrivateKeyPem: identity.privateKeyPem,
    });
    const stored = await rt.client.getStoredResult(rt.agentId, selfUcan, taskId);
    if (stored) return ok({ source: 'broker_reply', result: stored });
  } catch {
    // Fall through to status lookup on reply-inbox errors — the task may
    // still be in flight, or the sender may have used a webhook replyTo.
  }

  const state = await rt.client.getTaskStatus(targetAgentId, taskId);
  return ok({ source: 'task_state', state });
}

async function opInboxNext(waitMs: number): Promise<ToolResult> {
  let ctx;
  try { ctx = await brokerCtx(); } catch (e: any) { return err(e.message); }
  const { rt, selfUcan } = ctx;

  try {
    const result = await rt.client.inboxPull(rt.agentId, selfUcan, waitMs);
    if (!result) return ok({ task: null, message: 'No task available within wait window.' });
    return ok(result);
  } catch (e: any) {
    return err(`Inbox pull failed: ${e.message}`);
  }
}

async function opInboxRespond(args: RespondParams): Promise<ToolResult> {
  let ctx;
  try { ctx = await brokerCtx(); } catch (e: any) { return err(e.message); }
  const { rt, selfUcan } = ctx;

  try {
    const response = await rt.client.inboxRespond(rt.agentId, selfUcan, args.taskId, {
      status: args.status,
      ...(args.result !== undefined ? { result: args.result } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    });
    return ok(response);
  } catch (e: any) {
    return err(`Inbox respond failed: ${e.message}`);
  }
}

async function opReplyNext(waitMs: number): Promise<ToolResult> {
  let ctx;
  try { ctx = await brokerCtx(); } catch (e: any) { return err(e.message); }
  const { rt, selfUcan } = ctx;

  try {
    const reply = await rt.client.pullReply(rt.agentId, selfUcan, waitMs);
    if (!reply) return ok({ reply: null, message: 'No reply available within wait window.' });
    return ok(reply);
  } catch (e: any) {
    return err(`Reply pull failed: ${e.message}`);
  }
}

async function opReplyAck(taskId: string): Promise<ToolResult> {
  let ctx;
  try { ctx = await brokerCtx(); } catch (e: any) { return err(e.message); }
  const { rt, selfUcan } = ctx;

  try {
    const response = await rt.client.ackReply(rt.agentId, selfUcan, taskId);
    return ok(response);
  } catch (e: any) {
    return err(`Reply ack failed: ${e.message}`);
  }
}

async function opCreateTenant(args: { slug: string; name: string }): Promise<ToolResult> {
  if (!process.env['NOVA_ADMIN_TOKEN']) return err('NOVA_ADMIN_TOKEN env var required for operator actions');
  const client = bootstrapClient();
  const res = await client.createTenant(args);
  return ok(res);
}

async function opReissueGrant(args: { tenantId: string; agentId: string; expiryDays?: number }): Promise<ToolResult> {
  if (!process.env['NOVA_ADMIN_TOKEN']) return err('NOVA_ADMIN_TOKEN env var required for operator actions');
  const client = bootstrapClient();
  try {
    const res = await client.reissueGrant(args.tenantId, args.agentId, {
      ...(args.expiryDays !== undefined ? { expiryDays: args.expiryDays } : {}),
    });
    return ok(res);
  } catch (e: any) {
    return err(`Reissue failed: ${e.message}`);
  }
}

async function opCreateInvite(args: { tenantId: string; agentIdHint: string; ttlSeconds: number; note?: string }): Promise<ToolResult> {
  if (!process.env['NOVA_ADMIN_TOKEN']) return err('NOVA_ADMIN_TOKEN env var required for operator actions');
  const client = bootstrapClient();
  const res = await client.createInvite(args.tenantId, {
    agentIdHint: args.agentIdHint,
    ttlSeconds: args.ttlSeconds,
    ...(args.note !== undefined ? { note: args.note } : {}),
  });
  return ok(res);
}

async function opSubscribe(subscriptions: SubscriptionManager | undefined, uri: string): Promise<ToolResult> {
  if (!subscriptions) return err('Push subscriptions are not available in this MCP host. Use the corresponding next/pull action instead.');
  try {
    await subscriptions.subscribe(uri);
    return ok({ status: 'subscribed', uri });
  } catch (e: any) {
    return err(`Subscribe failed: ${e.message}`);
  }
}

async function opUnsubscribe(subscriptions: SubscriptionManager | undefined, uri: string): Promise<ToolResult> {
  if (!subscriptions) return err('Push subscriptions are not available in this MCP host.');
  await subscriptions.unsubscribe(uri);
  return ok({ status: 'unsubscribed', uri });
}

// Avoid an unused-import error for a constant kept for protocol parity with the
// claim-secret module; referenced here so removals stay intentional.
void CLAIM_SECRET_HEADER;

export function registerTools(_server: McpServer, subscriptions?: SubscriptionManager): void {
  // Cast to any: the MCP SDK's zod-compat generics blow TypeScript's inference depth
  // when combined with nested z.object/z.array/z.record. Runtime zod validation still runs
  // against whatever schemas we pass, so type-safety is preserved at the boundary.
  const server: any = _server;

  // ════════════════════════════════════════════════════════════════════════
  // Consolidated tools (7). Each takes a required `action` enum + action-
  // specific params (flat, all optional — see forAction for why). Logic lives
  // in the shared op* functions above; the legacy 1-tool-per-op surface below
  // delegates to the same functions and will move behind NOVA_MCP_LEGACY_TOOLS
  // in a follow-up.
  // ════════════════════════════════════════════════════════════════════════

  server.registerTool(
    'nova_identity',
    {
      title: 'Nova identity & approval-grant status',
      description:
        'Manage this runtime\'s Nova identity and report approval-grant status.\n\n' +
        'ACTIONS:\n' +
        '- generate(agentId)    → create an Ed25519 keypair + DID, stored at ~/.nova/agents/. Run once per runtime.\n' +
        '- whoami()             → active agentId, DID, tenant, grant summary, connected NOVA_URL.\n' +
        '- rotate_key(agentId?) → rotate the keypair (PoP-signed with the old key); surfaces the new DID to notify counterparties.\n' +
        '- grant_status()       → approval-grant cid / expiry / lifetime remaining. Renewal is operator-gated (see the `renewal` field).\n\n' +
        'TYPICAL ORDER: generate → (nova_onboard to join + register) → whoami to confirm.',
      inputSchema: {
        action: z.enum(['generate', 'whoami', 'rotate_key', 'grant_status']),
        agentId: z.string().optional().describe('generate: the new agent id (lowercase [a-z0-9_-]). rotate_key: target agent, defaults to NOVA_AGENT_ID.'),
      },
    },
    async (args: any): Promise<ToolResult> => {
      switch (args.action) {
        case 'generate':
          return forAction(z.object({ agentId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64) }), args, ({ agentId }) => opGenerateIdentity(agentId));
        case 'whoami':
          return opWhoami();
        case 'rotate_key':
          return forAction(z.object({ agentId: z.string().optional() }), args, ({ agentId }) => opRotateKey(agentId));
        case 'grant_status':
          return opGrantStatus(true);
        default:
          return err(`Unknown action '${args.action}'. Valid: generate, whoami, rotate_key, grant_status.`);
      }
    },
  );

  server.registerTool(
    'nova_onboard',
    {
      title: 'Join a Nova tenant & register this agent',
      description:
        'Invite-driven onboarding into a Nova tenant.\n\n' +
        'ACTIONS:\n' +
        '- inspect_invite(invite)            → decode an invite JWT locally (no network). Confirm agentIdHint before registering.\n' +
        '- accept_invite(invite, novaUrl?)   → verify + save the tenant locally. Does NOT consume the invite.\n' +
        '- register(agentId, name, description, invite, skills, operatorUrl?, replyUrl?) → POST /register. Invite consumed only on server-side success.\n' +
        '- check_status(agentId?)            → poll approval; when active, claim + cache the one-time approval grant.\n\n' +
        'TYPICAL ORDER: inspect_invite → accept_invite → register → check_status (repeat until active).',
      inputSchema: {
        action: z.enum(['inspect_invite', 'accept_invite', 'register', 'check_status']),
        invite: z.string().optional().describe('inspect_invite/accept_invite/register: the invite JWT from the operator.'),
        novaUrl: z.string().url().optional().describe('accept_invite: Nova a2a-server base URL. Defaults to NOVA_URL env.'),
        agentId: z.string().optional().describe('register: the agent id (must match identity + invite agentIdHint). check_status: defaults to NOVA_AGENT_ID.'),
        name: z.string().optional().describe('register: human-readable agent name.'),
        description: z.string().optional().describe('register: short description shown on the public agent card.'),
        skills: z.array(skillSchema).optional().describe('register: skills this agent accepts. Use [{ id: "__sender_only", name: "Sender only", description: "sends tasks only" }] for sender-only agents.'),
        operatorUrl: z.string().url().optional().describe('register: HTTPS endpoint Nova POSTs tasks to. Omit for sender-only.'),
        replyUrl: z.string().url().optional().describe('register: optional approval webhook.'),
      },
    },
    async (args: any): Promise<ToolResult> => {
      switch (args.action) {
        case 'inspect_invite':
          return forAction(z.object({ invite: z.string().min(1) }), args, ({ invite }) => opInspectInvite(invite));
        case 'accept_invite':
          return forAction(z.object({ invite: z.string().min(1), novaUrl: z.string().url().optional() }), args, ({ invite, novaUrl }) => opAcceptInvite(invite, novaUrl));
        case 'register':
          return forAction(registerParamsSchema, args, (v) => opRegister(v));
        case 'check_status':
          return forAction(z.object({ agentId: z.string().optional() }), args, ({ agentId }) => opCheckStatus(agentId));
        default:
          return err(`Unknown action '${args.action}'. Valid: inspect_invite, accept_invite, register, check_status.`);
      }
    },
  );

  server.registerTool(
    'nova_discover',
    {
      title: 'Discover agents & inspect skills',
      description:
        'Find other agents on Nova and inspect their skills.\n\n' +
        'ACTIONS:\n' +
        '- list(skills?, status?) → agents (optional skill substring filter; status defaults to active).\n' +
        '- card(agentId)          → full agent card incl. skill inputSchema/outputSchema. Use before nova_task send.',
      inputSchema: {
        action: z.enum(['list', 'card']),
        skills: z.string().optional().describe('list: substring match against skill ID/name/tag.'),
        status: z.enum(['active', 'pending', 'all']).optional().describe('list: defaults to active.'),
        agentId: z.string().optional().describe('card: the agent whose card to fetch.'),
      },
    },
    async (args: any): Promise<ToolResult> => {
      switch (args.action) {
        case 'list':
          return forAction(listParamsSchema, args, (v) => opListAgents(v));
        case 'card':
          return forAction(z.object({ agentId: z.string().min(1) }), args, ({ agentId }) => opGetCard(agentId));
        default:
          return err(`Unknown action '${args.action}'. Valid: list, card.`);
      }
    },
  );

  server.registerTool(
    'nova_task',
    {
      title: 'Send tasks & collect results',
      description:
        'Send tasks to other agents and collect their results.\n\n' +
        'ACTIONS:\n' +
        '- send(targetAgentId, intent, params, ttlMinutes?, idempotencyKey?, replyTo?) → mint a local invocation token + submit. Returns taskId.\n' +
        '- result(targetAgentId, taskId) → fetch the TaskResult (broker reply inbox, falling back to task state).\n' +
        '- watch(taskId) / unwatch(taskId) → fallback push subscription to nova://tasks/{taskId} (clients with resources/subscribe should skip).\n\n' +
        'TYPICAL ORDER: nova_discover card → send → result.',
      inputSchema: {
        action: z.enum(['send', 'result', 'watch', 'unwatch']),
        targetAgentId: z.string().optional().describe('send/result: destination agent ID.'),
        intent: z.string().optional().describe('send: skill ID declared in the destination agent card.'),
        params: z.record(z.unknown()).optional().describe('send: skill inputs; must validate against the destination inputSchema.'),
        ttlMinutes: z.number().int().min(1).max(1440).optional().describe('send: task TTL in minutes (default 60).'),
        idempotencyKey: z.string().optional().describe('send: optional idempotency key.'),
        replyTo: z.string().url().optional().describe('send: optional replyTo URL override.'),
        taskId: z.string().optional().describe('result/watch/unwatch: the task id.'),
      },
    },
    async (args: any): Promise<ToolResult> => {
      switch (args.action) {
        case 'send':
          return forAction(sendParamsSchema, args, (v) => opSendTask(v));
        case 'result':
          return forAction(z.object({ targetAgentId: z.string().min(1), taskId: z.string().min(1) }), args, ({ targetAgentId, taskId }) => opGetResult(targetAgentId, taskId));
        case 'watch':
          return forAction(z.object({ taskId: z.string().min(1) }), args, ({ taskId }) => opSubscribe(subscriptions, `nova://tasks/${taskId}`));
        case 'unwatch':
          return forAction(z.object({ taskId: z.string().min(1) }), args, ({ taskId }) => opUnsubscribe(subscriptions, `nova://tasks/${taskId}`));
        default:
          return err(`Unknown action '${args.action}'. Valid: send, result, watch, unwatch.`);
      }
    },
  );

  server.registerTool(
    'nova_inbox',
    {
      title: 'Broker-mode inbox: receive & complete tasks',
      description:
        'Receive and complete tasks addressed to this agent (no webhook needed).\n\n' +
        'ACTIONS:\n' +
        '- next(waitMs?) → long-poll a task; claims it for 5 min. Returns task:null on timeout.\n' +
        '- respond(taskId, status, result?, error?) → complete a claimed task before the 5-min visibility expires.\n' +
        '- watch() / unwatch() → fallback push subscription to nova://inbox (clients with resources/subscribe should skip).\n\n' +
        'TYPICAL LOOP: next → (do work) → respond.',
      inputSchema: {
        action: z.enum(['next', 'respond', 'watch', 'unwatch']),
        waitMs: z.number().int().min(0).max(60_000).optional().describe('next: max wait ms (server caps at 60s, default 30000).'),
        taskId: z.string().optional().describe('respond: the taskId from action:"next".'),
        status: z.enum(['ok', 'error']).optional().describe('respond: outcome.'),
        result: z.record(z.unknown()).optional().describe('respond + ok: payload shaped to the skill outputSchema.'),
        error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() }).optional().describe('respond + error: structured error detail.'),
      },
    },
    async (args: any): Promise<ToolResult> => {
      switch (args.action) {
        case 'next':
          return forAction(z.object({ waitMs: z.number().int().min(0).max(60_000).default(30_000) }), args, ({ waitMs }) => opInboxNext(waitMs));
        case 'respond':
          return forAction(respondParamsSchema, args, (v) => opInboxRespond(v));
        case 'watch':
          return opSubscribe(subscriptions, 'nova://inbox');
        case 'unwatch':
          return opUnsubscribe(subscriptions, 'nova://inbox');
        default:
          return err(`Unknown action '${args.action}'. Valid: next, respond, watch, unwatch.`);
      }
    },
  );

  server.registerTool(
    'nova_replies',
    {
      title: 'Broker-mode reply collection',
      description:
        'Collect TaskResults for tasks this agent sent without a replyTo webhook.\n\n' +
        'ACTIONS:\n' +
        '- next(waitMs?) → long-poll a reply; claims it for 5 min. Returns reply:null on timeout.\n' +
        '- ack(taskId)   → clear in-flight state so the reply is not redelivered. Idempotent.\n' +
        '- watch() / unwatch() → fallback push subscription to nova://replies (clients with resources/subscribe should skip).\n\n' +
        'TYPICAL LOOP: next → ack.',
      inputSchema: {
        action: z.enum(['next', 'ack', 'watch', 'unwatch']),
        waitMs: z.number().int().min(0).max(60_000).optional().describe('next: max wait ms (server caps at 60s, default 30000).'),
        taskId: z.string().optional().describe('ack: the taskId from action:"next".'),
      },
    },
    async (args: any): Promise<ToolResult> => {
      switch (args.action) {
        case 'next':
          return forAction(z.object({ waitMs: z.number().int().min(0).max(60_000).default(30_000) }), args, ({ waitMs }) => opReplyNext(waitMs));
        case 'ack':
          return forAction(z.object({ taskId: z.string().uuid() }), args, ({ taskId }) => opReplyAck(taskId));
        case 'watch':
          return opSubscribe(subscriptions, 'nova://replies');
        case 'unwatch':
          return opUnsubscribe(subscriptions, 'nova://replies');
        default:
          return err(`Unknown action '${args.action}'. Valid: next, ack, watch, unwatch.`);
      }
    },
  );

  server.registerTool(
    'nova_admin',
    {
      title: '[Operator] Tenant & credential administration',
      description:
        'Operator-only tenant and credential administration. Requires NOVA_ADMIN_TOKEN.\n\n' +
        'ACTIONS:\n' +
        '- create_tenant(slug, name)                               → create a galaxy.\n' +
        '- create_invite(tenantId, agentIdHint, ttlSeconds?, note?) → mint a one-time invite JWT.\n' +
        '- reissue_grant(tenantId, agentId, expiryDays?)           → regenerate an approval grant after the claim window lapsed.',
      inputSchema: {
        action: z.enum(['create_tenant', 'create_invite', 'reissue_grant']),
        slug: z.string().optional().describe('create_tenant: tenant slug ([a-z0-9-]).'),
        name: z.string().optional().describe('create_tenant: human-readable tenant name.'),
        tenantId: z.string().optional().describe('create_invite/reissue_grant: target tenant.'),
        agentIdHint: z.string().optional().describe('create_invite: the agentId the invite may register as.'),
        ttlSeconds: z.number().int().optional().describe('create_invite: invite TTL seconds (default 86400).'),
        note: z.string().optional().describe('create_invite: optional note.'),
        agentId: z.string().optional().describe('reissue_grant: the active agent to reissue for.'),
        expiryDays: z.number().int().optional().describe('reissue_grant: grant expiry days (default 30).'),
      },
    },
    async (args: any): Promise<ToolResult> => {
      switch (args.action) {
        case 'create_tenant':
          return forAction(z.object({ slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(64), name: z.string().min(1).max(200) }), args, (v) => opCreateTenant(v));
        case 'create_invite':
          return forAction(z.object({
            tenantId: z.string().min(1),
            agentIdHint: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64),
            ttlSeconds: z.number().int().min(60).max(7 * 24 * 3600).default(24 * 3600),
            note: z.string().max(200).optional(),
          }), args, (v) => opCreateInvite(v));
        case 'reissue_grant':
          return forAction(z.object({
            tenantId: z.string().min(1),
            agentId: z.string().min(1).max(64),
            expiryDays: z.number().int().min(1).max(365).optional(),
          }), args, (v) => opReissueGrant(v));
        default:
          return err(`Unknown action '${args.action}'. Valid: create_tenant, create_invite, reissue_grant.`);
      }
    },
  );

  // ════════════════════════════════════════════════════════════════════════
  // Legacy 1-tool-per-operation surface. Thin delegations to the same op*
  // functions. Kept for back-compat during the consolidation transition; to be
  // moved behind NOVA_MCP_LEGACY_TOOLS (default off) in a follow-up step.
  // ════════════════════════════════════════════════════════════════════════

  // ── Identity ─────────────────────────────────────────────────────────────

  server.registerTool(
    'nova_generate_identity',
    {
      title: 'Generate Nova agent identity',
      description: 'Create a new Ed25519 keypair and DID for this agent, stored locally in ~/.nova/agents/. Run once per agent runtime.',
      inputSchema: {
        agentId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64)
          .describe('Lowercase identifier for this agent (letters, digits, _ and - only). Will be the agent ID under the tenant.'),
      },
    },
    async ({ agentId }: { agentId: string }) => opGenerateIdentity(agentId),
  );

  server.registerTool(
    'nova_whoami',
    {
      title: 'Show current agent identity',
      description: 'Return the active agent\'s DID, tenant, UCAN status, and connected Nova URL.',
      inputSchema: {},
    },
    async () => opWhoami(),
  );

  // ── Onboarding ───────────────────────────────────────────────────────────

  server.registerTool(
    'nova_inspect_invite',
    {
      title: 'Inspect a Nova invite JWT without consuming it',
      description:
        'Decodes the invite payload locally — no network call, no server-side consumption. Returns tenantId, agentIdHint, expiresAt, jti, and an `expired` flag. Use this before nova_register_agent to confirm the agentIdHint matches the agentId you plan to register.',
      inputSchema: {
        invite: z.string().min(1).describe('Invite JWT from the tenant operator'),
      },
    },
    async ({ invite }: { invite: string }) => opInspectInvite(invite),
  );

  server.registerTool(
    'nova_accept_invite',
    {
      title: 'Join a Nova tenant via invite token',
      description: 'Accept a signed invite JWT (minted via POST /admin/tenants/:tenantId/invites) and save the tenant config locally. The token is not consumed here — it is consumed on nova_register_agent.',
      inputSchema: {
        invite: z.string().min(1).describe('Invite JWT obtained from the tenant operator'),
        novaUrl: z.string().url().optional().describe('Base URL for the Nova a2a-server. If omitted, uses NOVA_URL env.'),
      },
    },
    async ({ invite, novaUrl }: { invite: string; novaUrl?: string }) => opAcceptInvite(invite, novaUrl),
  );

  server.registerTool(
    'nova_register_agent',
    {
      title: 'Register this agent with the joined Nova tenant',
      description: 'POST /register using the stored invite and local identity. Agent starts in pending status; use nova_check_registration to await approval. The invite is only consumed after server-side validation succeeds, so AGENT_ID_MISMATCH / TENANT_NOT_FOUND / AGENT_EXISTS errors leave the token reusable — fix the input and retry with the same token. Call nova_inspect_invite first to confirm agentIdHint matches the agentId you will pass here.',
      inputSchema: registerParamsSchema,
    },
    async (args: RegisterParams) => opRegister(args),
  );

  server.registerTool(
    'nova_check_registration',
    {
      title: 'Poll registration status and claim UCAN on approval',
      description: 'Polls GET /register/status. When agent is active, retrieves the one-time approval grant, stores it locally, and returns the trust tier. If status is active but no grant is available AND no grant is cached locally, returns the GRANT_CLAIM_EXPIRED error — the claim window has lapsed and an operator must run nova_reissue_ucan.',
      inputSchema: {
        agentId: z.string().optional().describe('Defaults to NOVA_AGENT_ID env var.'),
      },
    },
    async ({ agentId }: { agentId?: string }) => opCheckStatus(agentId),
  );

  // ── UCAN management ──────────────────────────────────────────────────────

  server.registerTool(
    'nova_renew_ucan',
    {
      title: 'Report approval-grant status (refresh is operator-gated)',
      description:
        'In the delegation-chain model there is no client-side UCAN to refresh — per-request invocation tokens are minted locally on each nova_send_task. The long-lived approval grant is the only Nova-signed credential; if it is near expiry, ask the operator to run nova_reissue_ucan. This tool reports current grant status (expiry, lifetime remaining, cid).',
      inputSchema: {},
    },
    async () => opGrantStatus(false),
  );

  server.registerTool(
    'nova_rotate_key',
    {
      title: 'Rotate this agent\'s Ed25519 keypair',
      description:
        'Generates a fresh keypair locally, proves possession of the old key, and swaps the registered public key + DID on Nova. All UCANs issued to the old DID in this tenant are revoked; a fresh self-UCAN is minted for the new DID. The old identity file is preserved at {agentId}.json.rotated-{ISO}.bak for audit. Trust-registry tier + allowedSkills carry over automatically. NOTE: same-tenant trust is rebuilt transparently, but other tenants that trusted the old DID must re-seed with the new DID — the response lists nothing explicit (cross-tenant discovery is operator-driven) so surface the new DID to the user so they can notify counterparties.',
      inputSchema: {
        agentId: z.string().optional().describe('Defaults to NOVA_AGENT_ID env var.'),
      },
    },
    async ({ agentId }: { agentId?: string }) => opRotateKey(agentId),
  );

  server.registerTool(
    'nova_ucan_status',
    {
      title: 'Show approval-grant status',
      description:
        'Reports the approval grant cached locally: expiry, lifetime remaining, cid. In the delegation-chain model the grant is the only Nova-signed credential held client-side; invocation tokens are minted per-send and not cached.',
      inputSchema: {},
    },
    async () => opUcanStatus(),
  );

  // ── Discovery ────────────────────────────────────────────────────────────

  server.registerTool(
    'nova_list_agents',
    {
      title: 'List agents registered on Nova',
      description: 'Discover other agents. Filter by skill substring or status. Returns agentId, tenantId, name, skills.',
      inputSchema: {
        skills: z.string().optional().describe('Substring match against skill ID/name/tag'),
        status: z.enum(['active', 'pending', 'all']).default('active'),
      },
    },
    async (args: z.infer<typeof listParamsSchema>) => opListAgents(args),
  );

  server.registerTool(
    'nova_get_agent_card',
    {
      title: 'Fetch a specific agent\'s Nova agent card',
      description: 'Returns full skill definitions including inputSchema/outputSchema. Use this before nova_send_task to shape the params correctly.',
      inputSchema: { agentId: z.string().min(1) },
    },
    async ({ agentId }: { agentId: string }) => opGetCard(agentId),
  );

  // ── Sending tasks ────────────────────────────────────────────────────────

  server.registerTool(
    'nova_send_task',
    {
      title: 'Send a task to another agent via Nova',
      description:
        'Mints a short-lived invocation token locally (signed by this agent\'s Ed25519 key, with the approval grant carried as proof) and submits the task. Returns taskId + statusUrl/streamUrl for tracking.',
      inputSchema: sendParamsSchema,
    },
    async (args: SendParams) => opSendTask(args),
  );

  server.registerTool(
    'nova_get_task_result',
    {
      title: 'Fetch the final TaskResult for a sent task, falling back to status',
      description:
        'Returns the TaskResult payload when available from this agent\'s broker reply inbox (preferred for broker-mode senders). Falls back to the target\'s task state if no stored reply exists — useful while a task is still in progress or for webhook-mode senders whose result is delivered to their replyTo URL rather than a Nova inbox.',
      inputSchema: {
        targetAgentId: z.string().min(1),
        taskId: z.string().min(1),
      },
    },
    async ({ targetAgentId, taskId }: { targetAgentId: string; taskId: string }) => opGetResult(targetAgentId, taskId),
  );

  server.registerTool(
    'nova_next_task',
    {
      title: 'Pull the next pending task from this agent\'s inbox',
      description:
        'Long-polls up to waitMs for a task addressed to the active agent. Returns null on timeout. The returned task is claimed into an in-flight state with a 5-minute visibility timeout; call nova_respond before the timeout expires or the task will be redelivered to the next pull.',
      inputSchema: {
        waitMs: z.number().int().min(0).max(60_000).default(30_000).describe('Max milliseconds to wait for a task. Server caps at 60s.'),
      },
    },
    async ({ waitMs }: { waitMs: number }) => opInboxNext(waitMs),
  );

  server.registerTool(
    'nova_next_reply',
    {
      title: 'Pull the next TaskResult from this agent\'s broker reply inbox',
      description:
        'Long-polls up to waitMs for a TaskResult addressed to the active agent as sender. Returns null on timeout. Replies are claimed into an in-flight state with a 5-minute visibility timeout — call nova_ack_reply before it expires or the reply will be redelivered. Use this when you sent a task without a replyTo webhook and need to collect the result.',
      inputSchema: {
        waitMs: z.number().int().min(0).max(60_000).default(30_000).describe('Max milliseconds to wait for a reply. Server caps at 60s.'),
      },
    },
    async ({ waitMs }: { waitMs: number }) => opReplyNext(waitMs),
  );

  server.registerTool(
    'nova_ack_reply',
    {
      title: 'Ack a reply this agent pulled from its broker reply inbox',
      description:
        'Clears the in-flight state for a pulled reply so it is not redelivered. Must be called within the visibility timeout (5 minutes from nova_next_reply). Idempotent — a second call returns { status: "already_acked" }. The stored TaskResult remains retrievable via nova_get_task_result for 24 hours regardless.',
      inputSchema: {
        taskId: z.string().uuid().describe('The taskId from the reply returned by nova_next_reply'),
      },
    },
    async ({ taskId }: { taskId: string }) => opReplyAck(taskId),
  );

  server.registerTool(
    'nova_respond',
    {
      title: 'Complete a task this agent pulled from its inbox',
      description:
        'Ships a TaskResult back to the original sender. Must be called within the visibility timeout (5 minutes from nova_next_task) or the task will be redelivered. Idempotent — calling twice with the same taskId returns { status: "already_completed" } without re-shipping.',
      inputSchema: respondParamsSchema,
    },
    async (args: RespondParams) => opInboxRespond(args),
  );

  // ── Operator-only convenience (requires NOVA_ADMIN_TOKEN) ────────────────

  server.registerTool(
    'nova_create_tenant',
    {
      title: '[Operator] Create a new tenant (galaxy)',
      description: 'Requires NOVA_ADMIN_TOKEN. Creates a tenant that agents can then join via invite.',
      inputSchema: {
        slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(64),
        name: z.string().min(1).max(200),
      },
    },
    async (args: { slug: string; name: string }) => opCreateTenant(args),
  );

  server.registerTool(
    'nova_reissue_ucan',
    {
      title: '[Operator] Reissue a self-UCAN for an approved agent',
      description: 'Requires NOVA_ADMIN_TOKEN. Use when an already-approved agent missed its one-time grant claim window (returns GRANT_CLAIM_EXPIRED from nova_check_registration) or lost the cached credential. Idempotent: overwrites any pending claim with a fresh grant. The agent should call nova_check_registration afterwards to pick it up. Capabilities are recovered from the trust-registry entry seeded at approval — tier + allowedSkills are preserved.',
      inputSchema: {
        tenantId: z.string().min(1).describe('Tenant the agent belongs to'),
        agentId: z.string().min(1).max(64).describe('Agent to reissue for — must already be in status=active'),
        expiryDays: z.number().int().min(1).max(365).optional().describe('UCAN expiry in days. Defaults to 30.'),
      },
    },
    async (args: { tenantId: string; agentId: string; expiryDays?: number }) => opReissueGrant(args),
  );

  server.registerTool(
    'nova_create_invite',
    {
      title: '[Operator] Mint an invite token for a tenant',
      description: 'Requires NOVA_ADMIN_TOKEN. Returns a JWT to share with a new agent. One-time use. agentIdHint is required — mint one invite per agent you want to onboard.',
      inputSchema: {
        tenantId: z.string().min(1),
        agentIdHint: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64)
          .describe('The agentId the receiving runtime will register as. Invite can only be used to register exactly this agentId.'),
        ttlSeconds: z.number().int().min(60).max(7 * 24 * 3600).default(24 * 3600),
        note: z.string().max(200).optional(),
      },
    },
    async (args: { tenantId: string; agentIdHint: string; ttlSeconds: number; note?: string }) => opCreateInvite(args),
  );

  // ── Push subscriptions ───────────────────────────────────────────────────
  //
  // Fallback surface for MCP clients that don't implement resources/subscribe.
  // Semantically identical — each watch tool opens a backing SSE stream and
  // emits notifications/resources/updated on new events. Clients that do
  // implement resources/subscribe should prefer that path and ignore these.

  if (subscriptions) {
    const subs = subscriptions;

    server.registerTool(
      'nova_watch_inbox',
      {
        title: 'Subscribe to inbox notifications',
        description:
          'Opens a push stream for this agent\'s inbox. On each new task, an MCP notifications/resources/updated is emitted for nova://inbox. Notification is a hint — claim still happens via nova_next_task. Idempotent: calling twice keeps the single underlying stream.',
        inputSchema: {},
      },
      async () => opSubscribe(subs, 'nova://inbox'),
    );

    server.registerTool(
      'nova_unwatch_inbox',
      {
        title: 'Stop inbox notifications',
        description: 'Closes the backing stream for nova://inbox. Idempotent.',
        inputSchema: {},
      },
      async () => opUnsubscribe(subs, 'nova://inbox'),
    );

    server.registerTool(
      'nova_watch_replies',
      {
        title: 'Subscribe to reply-inbox notifications',
        description:
          'Opens a push stream for this agent\'s broker-reply inbox. On each new reply, an MCP notifications/resources/updated is emitted for nova://replies. Notification is a hint — claim still happens via nova_next_reply. Idempotent.',
        inputSchema: {},
      },
      async () => opSubscribe(subs, 'nova://replies'),
    );

    server.registerTool(
      'nova_unwatch_replies',
      {
        title: 'Stop reply-inbox notifications',
        description: 'Closes the backing stream for nova://replies. Idempotent.',
        inputSchema: {},
      },
      async () => opUnsubscribe(subs, 'nova://replies'),
    );

    server.registerTool(
      'nova_watch_task',
      {
        title: 'Subscribe to task-state notifications',
        description:
          'Opens a push stream for a specific task. On every state change, an MCP notifications/resources/updated is emitted for nova://tasks/{taskId}. Stream closes when the task reaches a terminal state (completed / failed / canceled).',
        inputSchema: {
          taskId: z.string().min(1).describe('Task ID returned from nova_send_task.'),
        },
      },
      async ({ taskId }: { taskId: string }) => opSubscribe(subs, `nova://tasks/${taskId}`),
    );

    server.registerTool(
      'nova_unwatch_task',
      {
        title: 'Stop task-state notifications',
        description: 'Closes the backing stream for nova://tasks/{taskId}. Idempotent.',
        inputSchema: {
          taskId: z.string().min(1),
        },
      },
      async ({ taskId }: { taskId: string }) => opUnsubscribe(subs, `nova://tasks/${taskId}`),
    );
  }
}
