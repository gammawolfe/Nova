import { request } from 'undici';

export interface NovaClientOptions {
  novaUrl: string;             // Base URL for a2a-server, e.g. https://nova.example.com
  adminUrl?: string;           // Base URL for admin-api; defaults to novaUrl with /admin prefix already handled
  adminToken?: string;         // Bearer token for admin endpoints (only needed for invite creation, tenant create, etc.)
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
}

async function json<T = unknown>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const opts: any = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await request(url, opts);
  const text = await res.body.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (res.statusCode >= 400) {
    const err: any = new Error(
      `${method} ${url} -> ${res.statusCode}: ${typeof parsed === 'object' ? (parsed.error ?? parsed.message ?? text) : text}`,
    );
    err.status = res.statusCode;
    err.body = parsed;
    throw err;
  }
  return parsed as T;
}

export class NovaClient {
  constructor(private readonly opts: NovaClientOptions) {}

  // ── Registration ─────────────────────────────────────────────────────────

  async register(payload: {
    invite: string;
    agentId: string;
    name: string;
    description?: string | undefined;
    publicKey: string;
    did: string;
    operatorUrl?: string | undefined;
    skills: Array<{ id: string; name: string; description: string; tags?: string[] | undefined; inputSchema?: unknown; outputSchema?: unknown }>;
    replyUrl?: string | undefined;
  }): Promise<{ status: 'pending'; tenantId: string; agentId: string; statusUrl: string }> {
    return json('POST', joinUrl(this.opts.novaUrl, '/register'), payload);
  }

  async registrationStatus(tenantId: string, agentId: string): Promise<{
    status: 'pending' | 'active' | 'deregistered';
    tenantId: string;
    agentId: string;
    ucan?: { jwt: string; cid: string; expiresAt: string; trustTier?: number; ucanRenewalUrl?: string };
  }> {
    return json('GET', joinUrl(this.opts.novaUrl, `/register/status/${tenantId}/${agentId}`));
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  async listAgents(params: { status?: 'active' | 'pending' | 'all'; skills?: string; agentId?: string } = {}): Promise<any> {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.skills) qs.set('skills', params.skills);
    if (params.agentId) qs.set('agentId', params.agentId);
    const q = qs.toString();
    return json('GET', joinUrl(this.opts.novaUrl, `/discover${q ? '?' + q : ''}`));
  }

  async getAgent(agentId: string): Promise<any> {
    return json('GET', joinUrl(this.opts.novaUrl, `/discover/${agentId}`));
  }

  async getAgentCard(agentId: string): Promise<any> {
    return json('GET', joinUrl(this.opts.novaUrl, `/agents/${agentId}/.well-known/agent.json`));
  }

  // ── UCAN ─────────────────────────────────────────────────────────────────

  async renewNonce(tenantId: string, did: string, agentId: string): Promise<{ nonce: string; expiresAt: string }> {
    const qs = new URLSearchParams({ did, agentId });
    return json('GET', joinUrl(this.adminBase(), `/admin/tenants/${tenantId}/ucans/renew?${qs}`));
  }

  async renewSubmit(tenantId: string, data: { did: string; agentId: string; nonce: string; signature: string }): Promise<{
    jwt: string; cid: string; expiresAt: string;
  }> {
    return json('POST', joinUrl(this.adminBase(), `/admin/tenants/${tenantId}/ucans/renew`), data);
  }

  async requestUcan(sourceTenantId: string, data: {
    did: string;
    agentId: string;
    nonce: string;
    signature: string;
    destTenantId: string;
    destAgentId: string;
    skills: string[];
    expiryDays?: number;
  }): Promise<{ jwt: string; cid: string; expiresAt: string }> {
    return json('POST', joinUrl(this.adminBase(), `/admin/tenants/${sourceTenantId}/ucans/request`), data);
  }

  // ── Task operations ──────────────────────────────────────────────────────

  async sendTask(
    targetAgentId: string,
    ucan: string,
    payload: { id: string; schemaVersion: '1.0'; intent: string; params: Record<string, unknown>; replyTo: string; ttl: string; idempotencyKey: string },
  ): Promise<{ status: 'submitted' | 'quarantined'; taskId: string; statusUrl?: string; streamUrl?: string; reason?: string }> {
    return json(
      'POST',
      joinUrl(this.opts.novaUrl, `/agents/${targetAgentId}/tasks`),
      payload,
      { authorization: `UCAN ${ucan}`, 'x-a2a-version': '1.0' },
    );
  }

  async getTaskStatus(targetAgentId: string, taskId: string): Promise<any> {
    return json('GET', joinUrl(this.opts.novaUrl, `/agents/${targetAgentId}/tasks/${taskId}`));
  }

  // ── Admin (tenant/invite) — requires adminToken ──────────────────────────

  async createTenant(data: { name: string; slug: string }): Promise<{ id: string; name: string; slug: string }> {
    return json('POST', joinUrl(this.adminBase(), '/admin/tenants'), data, this.adminHeaders());
  }

  async createInvite(tenantId: string, data: { agentIdHint?: string; ttlSeconds?: number; note?: string } = {}): Promise<{ token: string; expiresAt: string; tenantId: string }> {
    return json('POST', joinUrl(this.adminBase(), `/admin/tenants/${tenantId}/invites`), data, this.adminHeaders());
  }

  private adminBase(): string {
    return this.opts.adminUrl ?? this.opts.novaUrl;
  }

  private adminHeaders(): Record<string, string> {
    return this.opts.adminToken ? { authorization: `Bearer ${this.opts.adminToken}` } : {};
  }
}
