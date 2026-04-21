import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  generateIdentity,
  saveIdentity,
  loadIdentity,
  listAgentIds,
} from './identity.js';
import { loadTenantConfig, saveTenantConfig, decodeInvitePayload } from './tenant-config.js';
import { loadAgentRuntime, bootstrapClient } from './context.js';
import {
  ensureSelfUcan,
  ensureDestinationUcan,
  loadCache as loadUcanCache,
  remainingFraction,
} from './ucan-store.js';
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

export function registerTools(_server: McpServer): void {
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
      let ucanSummary: any = null;
      if (active && activeIdentity) {
        const cache = await loadUcanCache(active);
        ucanSummary = {
          self: cache.self ? { expiresAt: cache.self.expiresAt, lifetimeRemaining: remainingFraction(cache.self) } : null,
          destinations: Object.fromEntries(
            Object.entries(cache.perDestination ?? {}).map(([k, v]) => [k, { expiresAt: v.expiresAt, lifetimeRemaining: remainingFraction(v) }]),
          ),
        };
      }
      return ok({
        activeAgentId: active ?? null,
        activeDid: activeIdentity?.did ?? null,
        tenant: tenant ?? null,
        allLocalAgents: agentIds,
        ucan: ucanSummary,
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
      description: 'Polls GET /register/status. When agent is active, retrieves the one-time UCAN claim, stores it locally, and returns the trust tier. If status is active but no UCAN is available AND no UCAN is cached locally, returns the UCAN_CLAIM_EXPIRED error — the claim window has lapsed and an operator must run nova_reissue_ucan.',
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
      const status = await client.registrationStatus(tenant.tenantId, resolvedAgentId);

      if (status.status === 'active' && status.ucan) {
        const { loadCache, saveCache, withCacheLock } = await import('./ucan-store.js');
        // Lock + re-read + merge + save, so a concurrent nova_renew_ucan on
        // the same agent can't clobber the freshly-claimed self-UCAN (or
        // vice versa).
        await withCacheLock(resolvedAgentId, async () => {
          const cache = await loadCache(resolvedAgentId);
          cache.self = {
            jwt: status.ucan!.jwt,
            cid: status.ucan!.cid,
            expiresAt: status.ucan!.expiresAt,
            ...(status.ucan!.ucanRenewalUrl ? { ucanRenewalUrl: status.ucan!.ucanRenewalUrl } : {}),
          };
          await saveCache(cache);
        });
        return ok({
          status: 'active',
          claimed: true,
          trustTier: status.ucan.trustTier,
          ucanExpiresAt: status.ucan.expiresAt,
        });
      }

      // Status active, no UCAN in response. Either (a) the claim was already
      // consumed by a prior call and the local cache holds it, or (b) the
      // claim window expired before we polled. Disambiguate via local cache.
      if (status.status === 'active') {
        const { loadCache } = await import('./ucan-store.js');
        const cache = await loadCache(resolvedAgentId);
        if (!cache.self) {
          return err(
            `UCAN_CLAIM_EXPIRED: Agent '${resolvedAgentId}' is active, but the one-time UCAN claim is no longer available and no UCAN is cached locally. Ask the operator to run nova_reissue_ucan with tenantId='${tenant.tenantId}' agentId='${resolvedAgentId}' (requires NOVA_ADMIN_TOKEN), then call nova_check_registration again.`,
          );
        }
        return ok({
          status: 'active',
          claimed: false,
          note: 'Agent active; UCAN claim already consumed — using cached self-UCAN.',
          ucanExpiresAt: cache.self.expiresAt,
        });
      }

      return ok({ status: status.status, claimed: false });
    },
  );

  // ── UCAN management ──────────────────────────────────────────────────────

  server.registerTool(
    'nova_renew_ucan',
    {
      title: 'Renew the self-UCAN via proof-of-possession',
      description: 'Force a UCAN refresh (even if current one is still fresh). Normally not needed — nova_send_task renews automatically below 20% lifetime.',
      inputSchema: {},
    },
    async () => {
      const rt = await loadAgentRuntime();
      if (!rt) return err('No active agent runtime. Set NOVA_AGENT_ID and ensure identity + tenant are configured.');
      const identity = await loadIdentity(rt.agentId);
      if (!identity) return err(`Identity missing for ${rt.agentId}`);
      const tenant = await loadTenantConfig();
      if (!tenant) return err('No tenant config');
      const jwt = await ensureSelfUcan(rt.client, tenant.tenantId, rt.agentId, identity.did, identity.privateKeyPem, 1.1 /* force */);
      return ok({ status: 'renewed', jwtPreview: jwt.slice(0, 48) + '…' });
    },
  );

  server.registerTool(
    'nova_check_status',
    {
      title: 'Probe an agent\'s status and optionally its UCAN state',
      description:
        'Lightweight pre-flight probe against GET /agents/:agentId/health. Returns { agentStatus, ucan? } where agentStatus is active|pending|deregistered|unknown and ucan (when a cid is provided) tells you whether that specific UCAN has been revoked or is still issued. Responses cache in-process for 5 minutes keyed by (agentId, cid) so repeated calls are cheap — the cache auto-invalidates on rotation because the cid changes. Advisory only: the gate pipeline remains the authoritative boundary.',
      inputSchema: {
        agentId: z.string().optional().describe('Agent to probe. Defaults to the active agent (NOVA_AGENT_ID).'),
        ucanCid: z.string().optional().describe('Optional CID of a UCAN to check for revocation. Defaults to the cached self-UCAN of the active agent.'),
      },
    },
    async ({ agentId, ucanCid }) => {
      const rt = await loadAgentRuntime();
      const client = rt?.client ?? bootstrapClient();
      const resolvedAgentId = agentId ?? rt?.agentId;
      if (!resolvedAgentId) return err('agentId argument or NOVA_AGENT_ID env var required');

      // If no cid passed and the caller is probing their own agent, default
      // to the cached self-UCAN cid so the common "is my current UCAN still
      // good?" question is answerable without extra plumbing.
      let resolvedCid = ucanCid;
      if (!resolvedCid && rt && resolvedAgentId === rt.agentId) {
        const cache = await loadUcanCache(rt.agentId);
        resolvedCid = cache.self?.cid;
      }

      try {
        const response = await getHealth(client, resolvedAgentId, resolvedCid);
        return ok(response);
      } catch (e: any) {
        return err(`Status probe failed: ${e.message}`);
      }
    },
  );

  server.registerTool(
    'nova_ucan_status',
    {
      title: 'Show UCAN cache state',
      description: 'List self-UCAN and cached per-destination UCANs with remaining lifetime.',
      inputSchema: {},
    },
    async () => {
      const active = process.env['NOVA_AGENT_ID'];
      if (!active) return err('NOVA_AGENT_ID not set');
      const cache = await loadUcanCache(active);
      return ok({
        self: cache.self ? { expiresAt: cache.self.expiresAt, lifetimeRemaining: remainingFraction(cache.self) } : null,
        destinations: Object.entries(cache.perDestination ?? {}).map(([k, v]) => ({
          destination: k, expiresAt: v.expiresAt, lifetimeRemaining: remainingFraction(v),
        })),
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
      description: 'Acquires a per-destination UCAN (cached after first use) and submits a task. Returns taskId + statusUrl/streamUrl for tracking.',
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

      // Pre-flight: is THIS agent still active and its self-UCAN still valid?
      // Cached for 5 min per (agentId, cid) so the hot path is one map lookup.
      // Catches operator-driven revocations that would otherwise quarantine
      // the task at the destination's gate with no clear signal to the sender.
      try {
        const selfCache = await loadUcanCache(rt.agentId);
        const selfHealth = await getHealth(rt.client, rt.agentId, selfCache.self?.cid);
        if (selfHealth.agentStatus === 'deregistered') {
          return err(`AGENT_INACTIVE: this agent '${rt.agentId}' is deregistered in Nova. Contact the tenant operator — a fresh invite + registration is required before sending tasks.`);
        }
        if (selfHealth.agentStatus === 'pending') {
          return err(`AGENT_INACTIVE: this agent '${rt.agentId}' is still pending operator approval. Run nova_check_registration and wait for approval before sending tasks.`);
        }
        if (selfHealth.ucan?.revoked) {
          return err(`UCAN_REVOKED: this agent's self-UCAN (cid=${selfHealth.ucan.cid}) has been revoked. Ask the operator to run nova_reissue_ucan and then call nova_check_registration to pick up the fresh credential.`);
        }
      } catch (e: any) {
        // Advisory-only: don't block sends if the probe itself fails (e.g.
        // a2a-server unreachable). The gate will still enforce at submit time.
        // Just log through the tool output — keeps behaviour no worse than pre-P2.9.
      }

      const target = await rt.client.getAgent(args.targetAgentId);
      const destTenantId: string | undefined = target?.tenantId;
      if (!destTenantId) return err(`Destination agent '${args.targetAgentId}' not found or has no tenantId`);
      if (target?.status && target.status !== 'active') {
        return err(`DEST_AGENT_INACTIVE: destination '${args.targetAgentId}' is ${target.status}. Pick a different target via nova_list_agents or wait for the operator to approve it.`);
      }

      const ucan = await ensureDestinationUcan(
        rt.client,
        tenant.tenantId,
        rt.agentId,
        identity.did,
        identity.privateKeyPem,
        { tenantId: destTenantId, agentId: args.targetAgentId, skills: [args.intent] },
      );

      const ttlMs = args.ttlMinutes * 60 * 1000;
      const payload = {
        id: randomUUID(),
        schemaVersion: '1.0' as const,
        intent: args.intent,
        params: args.params,
        replyTo: args.replyTo ?? `${rt.novaUrl.replace(/\/$/, '')}/agents/${rt.agentId}/replies`,
        ttl: new Date(Date.now() + ttlMs).toISOString(),
        idempotencyKey: args.idempotencyKey ?? randomUUID(),
      };
      const result = await rt.client.sendTask(args.targetAgentId, ucan, payload);
      return ok(result);
    },
  );

  server.registerTool(
    'nova_get_task_result',
    {
      title: 'Poll a task until terminal, or return current state',
      description: 'Call once to get current status; call repeatedly to poll. Does not block for long — poll externally.',
      inputSchema: {
        targetAgentId: z.string().min(1),
        taskId: z.string().min(1),
      },
    },
    async ({ targetAgentId, taskId }) => {
      const rt = await loadAgentRuntime();
      if (!rt) return err('No active agent runtime');
      const state = await rt.client.getTaskStatus(targetAgentId, taskId);
      return ok(state);
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

      const selfUcan = await ensureSelfUcan(
        rt.client,
        tenant.tenantId,
        rt.agentId,
        identity.did,
        identity.privateKeyPem,
      );

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

      const selfUcan = await ensureSelfUcan(
        rt.client,
        tenant.tenantId,
        rt.agentId,
        identity.did,
        identity.privateKeyPem,
      );

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
      description: 'Requires NOVA_ADMIN_TOKEN. Use when an already-approved agent missed its one-time UCAN claim window (returns UCAN_CLAIM_EXPIRED from nova_check_registration) or lost the cached credential. Idempotent: overwrites any pending claim with a fresh UCAN. The agent should call nova_check_registration afterwards to pick it up. Capabilities are recovered from the trust-registry entry seeded at approval — tier + allowedSkills are preserved.',
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
        const res = await client.reissueUcan(args.tenantId, args.agentId, {
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
}
