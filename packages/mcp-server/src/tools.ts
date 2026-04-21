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

function ok(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function err(message: string): { isError: true; content: [{ type: 'text'; text: string }] } {
  return { isError: true, content: [{ type: 'text', text: message }] };
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
      description: 'Polls GET /register/status. When agent is active, retrieves the one-time UCAN claim, stores it locally, and returns the trust tier.',
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
        const { saveCache } = await import('./ucan-store.js');
        await saveCache({
          agentId: resolvedAgentId,
          self: {
            jwt: status.ucan.jwt,
            cid: status.ucan.cid,
            expiresAt: status.ucan.expiresAt,
            ...(status.ucan.ucanRenewalUrl ? { ucanRenewalUrl: status.ucan.ucanRenewalUrl } : {}),
          },
        });
        return ok({
          status: 'active',
          claimed: true,
          trustTier: status.ucan.trustTier,
          ucanExpiresAt: status.ucan.expiresAt,
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

      const target = await rt.client.getAgent(args.targetAgentId);
      const destTenantId: string | undefined = target?.tenantId;
      if (!destTenantId) return err(`Destination agent '${args.targetAgentId}' not found or has no tenantId`);

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
    'nova_create_invite',
    {
      title: '[Operator] Mint an invite token for a tenant',
      description: 'Requires NOVA_ADMIN_TOKEN. Returns a JWT to share with a new agent. One-time use.',
      inputSchema: {
        tenantId: z.string().min(1),
        agentIdHint: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64).optional(),
        ttlSeconds: z.number().int().min(60).max(7 * 24 * 3600).default(24 * 3600),
        note: z.string().max(200).optional(),
      },
    },
    async (args) => {
      if (!process.env['NOVA_ADMIN_TOKEN']) return err('NOVA_ADMIN_TOKEN env var required for operator actions');
      const client = bootstrapClient();
      const res = await client.createInvite(args.tenantId, {
        ...(args.agentIdHint !== undefined ? { agentIdHint: args.agentIdHint } : {}),
        ttlSeconds: args.ttlSeconds,
        ...(args.note !== undefined ? { note: args.note } : {}),
      });
      return ok(res);
    },
  );
}
