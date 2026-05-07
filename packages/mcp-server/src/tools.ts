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
import { generateClaimSecret, CLAIM_SECRET_HEADER } from '@nova/shared/src/claim-secret.js';
import { agentIdentityPath } from '@nova/shared/src/paths.js';
import fsp from 'fs/promises';
import type { NovaClient } from './nova-client.js';

function ok(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function err(message: string): { isError: true; content: [{ type: 'text'; text: string }] } {
  return { isError: true, content: [{ type: 'text', text: message }] };
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

export function registerTools(_server: McpServer, subscriptions?: import('./subscriptions.js').SubscriptionManager): void {
  // Cast to any: the MCP SDK's zod-compat generics blow TypeScript's inference depth
  // when combined with nested z.object/z.array/z.record. Runtime zod validation still runs
  // against whatever schemas we pass, so type-safety is preserved at the boundary.
  const server: any = _server;

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
    async ({ agentId }) => {
      const existing = await loadIdentity(agentId);
      if (existing) return err(`Identity for agent '${agentId}' already exists. Use nova_whoami to inspect it, or pick a different agentId.`);
      const identity = generateIdentity(agentId);
      await saveIdentity(identity);
      return ok({ agentId, did: identity.did, publicKey: identity.publicKey, createdAt: identity.createdAt });
    },
  );

  server.registerTool(
    'nova_whoami',
    {
      title: 'Show current agent identity',
      description: 'Return the active agent\'s DID, tenant, UCAN status, and connected Nova URL.',
      inputSchema: {},
    },
    async () => {
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
    },
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
    async ({ invite }) => {
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
    },
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
    async ({ invite, novaUrl }) => {
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
    },
  );

  server.registerTool(
    'nova_register_agent',
    {
      title: 'Register this agent with the joined Nova tenant',
      description: 'POST /register using the stored invite and local identity. Agent starts in pending status; use nova_check_registration to await approval. The invite is only consumed after server-side validation succeeds, so AGENT_ID_MISMATCH / TENANT_NOT_FOUND / AGENT_EXISTS errors leave the token reusable — fix the input and retry with the same token. Call nova_inspect_invite first to confirm agentIdHint matches the agentId you will pass here.',
      inputSchema: {
        agentId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64).describe('Must match an identity created via nova_generate_identity AND the agentIdHint claim in the invite JWT. Mismatches return AGENT_ID_MISMATCH but leave the invite reusable.'),
        name: z.string().min(1).max(200).describe('Human-readable agent name (displayed in admin UI / agent cards)'),
        description: z.string().min(1).max(1000).describe('Short description of what this agent does (required — appears on the public agent card).'),
        invite: z.string().min(1).describe('The invite JWT from the operator. Consumed only after server-side validation passes, so agent-side errors (mismatch, missing tenant, duplicate agent) leave it reusable. On successful 201, or on INVITE_INVALID, request a fresh token.'),
        skills: z.array(z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          description: z.string().min(1),
          tags: z.array(z.string()).optional(),
          inputSchema: z.record(z.unknown()).optional(),
          outputSchema: z.record(z.unknown()).optional(),
        })).min(1).describe('Skills this agent accepts. Senders may use the special skill { id: "__sender_only", name: "Sender only", description: "This agent sends tasks only; it does not receive." }'),
        operatorUrl: z.string().url().optional().describe('HTTPS endpoint Nova will POST tasks to. Omit for sender-only agents.'),
        replyUrl: z.string().url().optional().describe('Webhook Nova calls with { event: "agent_approved", ucan, ... } on approval. Optional — polling via nova_check_registration works without it.'),
      },
    },
    async (args) => {
      const tenant = await loadTenantConfig();
      if (!tenant) return err('No tenant joined. Run nova_accept_invite first.');

      const identity = await loadIdentity(args.agentId);
      if (!identity) return err(`No identity for '${args.agentId}'. Run nova_generate_identity first.`);

      // H17 — generate a fresh claim secret, persist alongside the identity,
      // send only the commitment to the server. If a secret already exists
      // locally (re-run after a transient register failure), reuse it so the
      // server-side commitment stays consistent.
      let claimSecret: string;
      let claimCommitment: string;
      if (identity.claimSecret) {
        const { commitmentOf } = await import('@nova/shared/src/claim-secret.js');
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
          nextStep: 'Operator must approve via admin UI. Then call nova_check_registration to claim UCAN.',
        });
      } catch (e: any) {
        return err(`Registration failed: ${e.message}`);
      }
    },
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
    async ({ agentId }) => {
      const tenant = await loadTenantConfig();
      if (!tenant) return err('No tenant joined. Run nova_accept_invite first.');
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
          `Ask the operator to run nova_reissue_ucan with tenantId='${tenant.tenantId}' agentId='${resolvedAgentId}' (requires NOVA_ADMIN_TOKEN). ` +
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
            `GRANT_CLAIM_EXPIRED: Agent '${resolvedAgentId}' is active, but the one-time grant claim is no longer available and no grant is cached locally. Ask the operator to run nova_reissue_ucan with tenantId='${tenant.tenantId}' agentId='${resolvedAgentId}' (requires NOVA_ADMIN_TOKEN), then call nova_check_registration again.`,
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
    },
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
    async () => {
      const rt = await loadAgentRuntime();
      if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID and ensure identity + tenant are configured.');
      const grant = await getGrantIfFresh(rt.agentId, 0);
      if (!grant) return err('No grant cached locally. Run nova_check_registration after operator approval.');
      return ok({
        cid: grant.cid,
        expiresAt: grant.expiresAt,
        lifetimeRemaining: remainingFraction(grant),
      });
    },
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
    async ({ agentId }) => {
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
      // nova_send_task / nova_renew_ucan on this agent can't observe a
      // half-rotated state (new identity on disk but old UCANs in cache).
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
    },
  );

  server.registerTool(
    'nova_ucan_status',
    {
      title: 'Show approval-grant status',
      description:
        'Reports the approval grant cached locally: expiry, lifetime remaining, cid. In the delegation-chain model the grant is the only Nova-signed credential held client-side; invocation tokens are minted per-send and not cached.',
      inputSchema: {},
    },
    async () => {
      const active = process.env['NOVA_AGENT_ID'];
      if (!active) return err('NOVA_AGENT_ID not set');
      const cache = await loadUcanCache(active);
      return ok({
        grant: cache.grant
          ? { cid: cache.grant.cid, expiresAt: cache.grant.expiresAt, lifetimeRemaining: remainingFraction(cache.grant) }
          : null,
      });
    },
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
    async (args) => {
      const rt = await loadAgentRuntime();
      const client = rt?.client ?? bootstrapClient();
      const res = await client.listAgents({
        status: args.status,
        ...(args.skills !== undefined ? { skills: args.skills } : {}),
      });
      return ok(res);
    },
  );

  server.registerTool(
    'nova_get_agent_card',
    {
      title: 'Fetch a specific agent\'s A2A agent card',
      description: 'Returns full skill definitions including inputSchema/outputSchema. Use this before nova_send_task to shape the params correctly.',
      inputSchema: { agentId: z.string().min(1) },
    },
    async ({ agentId }) => {
      const rt = await loadAgentRuntime();
      const client = rt?.client ?? bootstrapClient();
      const res = await client.getAgentCard(agentId);
      return ok(res);
    },
  );

  // ── Sending tasks ────────────────────────────────────────────────────────

  server.registerTool(
    'nova_send_task',
    {
      title: 'Send a task to another agent via Nova',
      description:
        'Mints a short-lived invocation token locally (signed by this agent\'s Ed25519 key, with the approval grant carried as proof) and submits the task. Returns taskId + statusUrl/streamUrl for tracking.',
      inputSchema: {
        targetAgentId: z.string().min(1).describe('Destination agent ID (from nova_list_agents)'),
        intent: z.string().min(1).describe('Skill ID declared in the destination agent card'),
        params: z.record(z.unknown()).describe('Skill inputs; must validate against the destination\'s inputSchema'),
        ttlMinutes: z.number().int().min(1).max(1440).default(60),
        idempotencyKey: z.string().optional(),
        replyTo: z.string().url().optional().describe('Override replyTo URL (defaults to a discovery-time Nova reply slot)'),
      },
    },
    async (args) => {
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
          return err(`AGENT_INACTIVE: this agent '${rt.agentId}' is still pending operator approval. Run nova_check_registration and wait for approval before sending tasks.`);
        }
        if (selfHealth.ucan?.revoked) {
          return err(`GRANT_REVOKED: this agent's approval grant (cid=${selfHealth.ucan.cid}) has been revoked. Ask the operator to run nova_reissue_ucan and then call nova_check_registration to pick up the fresh grant.`);
        }
      } catch (e: any) {
        // Advisory-only: don't block sends if the probe itself fails.
      }

      if (!grant) {
        return err(`GRANT_MISSING: no valid grant cached for '${rt.agentId}'. Run nova_check_registration (after operator approval) to claim it.`);
      }

      const target = await rt.client.getAgent(args.targetAgentId);
      const destTenantId: string | undefined = target?.tenantId;
      if (!destTenantId) return err(`Destination agent '${args.targetAgentId}' not found or has no tenantId`);
      if (target?.status && target.status !== 'active') {
        return err(`DEST_AGENT_INACTIVE: destination '${args.targetAgentId}' is ${target.status}. Pick a different target via nova_list_agents or wait for the operator to approve it.`);
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
      // by the sender's DID. Fetch via nova_next_reply or nova_get_task_result.
      if (args.replyTo) payload.replyTo = args.replyTo;
      const result = await rt.client.sendTask(args.targetAgentId, ucan, payload);
      return ok(result);
    },
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
    async ({ targetAgentId, taskId }) => {
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
    },
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
    async ({ waitMs }) => {
      const rt = await loadAgentRuntime();
      if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID.');
      const identity = await loadIdentity(rt.agentId);
      if (!identity) return err(`Identity missing for ${rt.agentId}`);
      const tenant = await loadTenantConfig();
      if (!tenant) return err('No tenant joined');

      const selfUcan = mintSelfAuthToken({
        senderDid: identity.did,
        senderPrivateKeyPem: identity.privateKeyPem,
      });

      try {
        const result = await rt.client.inboxPull(rt.agentId, selfUcan, waitMs);
        if (!result) return ok({ task: null, message: 'No task available within wait window.' });
        return ok(result);
      } catch (e: any) {
        return err(`Inbox pull failed: ${e.message}`);
      }
    },
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
    async ({ waitMs }) => {
      const rt = await loadAgentRuntime();
      if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID.');
      const identity = await loadIdentity(rt.agentId);
      if (!identity) return err(`Identity missing for ${rt.agentId}`);
      const tenant = await loadTenantConfig();
      if (!tenant) return err('No tenant joined');

      const selfUcan = mintSelfAuthToken({
        senderDid: identity.did,
        senderPrivateKeyPem: identity.privateKeyPem,
      });

      try {
        const reply = await rt.client.pullReply(rt.agentId, selfUcan, waitMs);
        if (!reply) return ok({ reply: null, message: 'No reply available within wait window.' });
        return ok(reply);
      } catch (e: any) {
        return err(`Reply pull failed: ${e.message}`);
      }
    },
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
    async ({ taskId }) => {
      const rt = await loadAgentRuntime();
      if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID.');
      const identity = await loadIdentity(rt.agentId);
      if (!identity) return err(`Identity missing for ${rt.agentId}`);
      const tenant = await loadTenantConfig();
      if (!tenant) return err('No tenant joined');

      const selfUcan = mintSelfAuthToken({
        senderDid: identity.did,
        senderPrivateKeyPem: identity.privateKeyPem,
      });

      try {
        const response = await rt.client.ackReply(rt.agentId, selfUcan, taskId);
        return ok(response);
      } catch (e: any) {
        return err(`Reply ack failed: ${e.message}`);
      }
    },
  );

  server.registerTool(
    'nova_respond',
    {
      title: 'Complete a task this agent pulled from its inbox',
      description:
        'Ships a TaskResult back to the original sender. Must be called within the visibility timeout (5 minutes from nova_next_task) or the task will be redelivered. Idempotent — calling twice with the same taskId returns { status: "already_completed" } without re-shipping.',
      inputSchema: z.object({
        taskId: z.string().uuid().describe('The taskId returned by nova_next_task'),
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
      }),
    },
    async ({ taskId, status, result, error }) => {
      const rt = await loadAgentRuntime();
      if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID.');
      const identity = await loadIdentity(rt.agentId);
      if (!identity) return err(`Identity missing for ${rt.agentId}`);
      const tenant = await loadTenantConfig();
      if (!tenant) return err('No tenant joined');

      const selfUcan = mintSelfAuthToken({
        senderDid: identity.did,
        senderPrivateKeyPem: identity.privateKeyPem,
      });

      try {
        const response = await rt.client.inboxRespond(rt.agentId, selfUcan, taskId, {
          status,
          ...(result !== undefined ? { result } : {}),
          ...(error !== undefined ? { error } : {}),
        });
        return ok(response);
      } catch (e: any) {
        return err(`Inbox respond failed: ${e.message}`);
      }
    },
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
    async (args) => {
      if (!process.env['NOVA_ADMIN_TOKEN']) return err('NOVA_ADMIN_TOKEN env var required for operator actions');
      const client = bootstrapClient();
      const res = await client.createTenant(args);
      return ok(res);
    },
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
    async (args) => {
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
    },
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
    async (args) => {
      if (!process.env['NOVA_ADMIN_TOKEN']) return err('NOVA_ADMIN_TOKEN env var required for operator actions');
      const client = bootstrapClient();
      const res = await client.createInvite(args.tenantId, {
        agentIdHint: args.agentIdHint,
        ttlSeconds: args.ttlSeconds,
        ...(args.note !== undefined ? { note: args.note } : {}),
      });
      return ok(res);
    },
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
      async () => {
        try {
          await subs.subscribe('nova://inbox');
          return ok({ status: 'subscribed', uri: 'nova://inbox' });
        } catch (e: any) {
          return err(`Subscribe failed: ${e.message}`);
        }
      },
    );

    server.registerTool(
      'nova_unwatch_inbox',
      {
        title: 'Stop inbox notifications',
        description: 'Closes the backing stream for nova://inbox. Idempotent.',
        inputSchema: {},
      },
      async () => {
        await subs.unsubscribe('nova://inbox');
        return ok({ status: 'unsubscribed', uri: 'nova://inbox' });
      },
    );

    server.registerTool(
      'nova_watch_replies',
      {
        title: 'Subscribe to reply-inbox notifications',
        description:
          'Opens a push stream for this agent\'s broker-reply inbox. On each new reply, an MCP notifications/resources/updated is emitted for nova://replies. Notification is a hint — claim still happens via nova_next_reply. Idempotent.',
        inputSchema: {},
      },
      async () => {
        try {
          await subs.subscribe('nova://replies');
          return ok({ status: 'subscribed', uri: 'nova://replies' });
        } catch (e: any) {
          return err(`Subscribe failed: ${e.message}`);
        }
      },
    );

    server.registerTool(
      'nova_unwatch_replies',
      {
        title: 'Stop reply-inbox notifications',
        description: 'Closes the backing stream for nova://replies. Idempotent.',
        inputSchema: {},
      },
      async () => {
        await subs.unsubscribe('nova://replies');
        return ok({ status: 'unsubscribed', uri: 'nova://replies' });
      },
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
      async ({ taskId }: { taskId: string }) => {
        const uri = `nova://tasks/${taskId}`;
        try {
          await subs.subscribe(uri);
          return ok({ status: 'subscribed', uri });
        } catch (e: any) {
          return err(`Subscribe failed: ${e.message}`);
        }
      },
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
      async ({ taskId }: { taskId: string }) => {
        const uri = `nova://tasks/${taskId}`;
        await subs.unsubscribe(uri);
        return ok({ status: 'unsubscribed', uri });
      },
    );
  }
}
