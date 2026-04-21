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

  async getAgentHealth(agentId: string, ucanCid?: string): Promise<{
    agentId: string;
    agentStatus: 'active' | 'pending' | 'deregistered' | 'unknown';
    ucan?: { cid: string; revoked: boolean; found: boolean; expiresAt?: string };
  }> {
    const qs = ucanCid ? `?ucanCid=${encodeURIComponent(ucanCid)}` : '';
    return json('GET', joinUrl(this.opts.novaUrl, `/agents/${agentId}/health${qs}`));
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

  /**
   * Long-poll the agent's broker inbox. Returns null on 204 (timeout).
   * The returned task has been claimed into an in-flight state with a
   * 5-minute visibility timeout — call inboxRespond before it expires.
   */
  async inboxPull(
    agentId: string,
    selfUcan: string,
    waitMs: number,
  ): Promise<{ task: unknown; visibleUntil: string } | null> {
    const url = joinUrl(this.opts.novaUrl, `/agents/${encodeURIComponent(agentId)}/inbox?wait=${waitMs}`);
    const res = await request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${selfUcan}` },
    });
    if (res.statusCode === 204) return null;
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      let parsed: any;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      const err: any = new Error(
        `inboxPull failed: ${res.statusCode} ${typeof parsed === 'object' ? (parsed.error ?? parsed.message ?? text) : text}`,
      );
      err.status = res.statusCode;
      throw err;
    }
    const text = await res.body.text();
    return (text ? JSON.parse(text) : undefined) as { task: unknown; visibleUntil: string };
  }

  /**
   * Complete a task pulled from the inbox. Returns outcome enum.
   * Treats 404 and 409 as normal outcomes (not thrown errors) so callers
   * can surface 'task_not_found' / 'already_completed' cleanly.
   */
  async inboxRespond(
    agentId: string,
    selfUcan: string,
    taskId: string,
    body: {
      status: 'ok' | 'error';
      result?: unknown;
      error?: { code: string; message: string; retryable?: boolean };
    },
  ): Promise<{ status: 'accepted' | 'already_completed' | 'task_not_found' }> {
    const url = joinUrl(this.opts.novaUrl, `/agents/${encodeURIComponent(agentId)}/inbox/${encodeURIComponent(taskId)}/respond`);
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${selfUcan}` },
      body: JSON.stringify(body),
    });
    if (res.statusCode >= 400 && res.statusCode !== 404 && res.statusCode !== 409) {
      const text = await res.body.text();
      let parsed: any;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      const err: any = new Error(
        `inboxRespond failed: ${res.statusCode} ${typeof parsed === 'object' ? (parsed.error ?? parsed.message ?? text) : text}`,
      );
      err.status = res.statusCode;
      throw err;
    }
    const text = await res.body.text();
    return text ? JSON.parse(text) : { status: 'accepted' };
  }

  // ── Admin (tenant/invite) — requires adminToken ──────────────────────────

  async createTenant(data: { name: string; slug: string }): Promise<{ id: string; name: string; slug: string }> {
    return json('POST', joinUrl(this.adminBase(), '/admin/tenants'), data, this.adminHeaders());
  }

  async createInvite(tenantId: string, data: { agentIdHint: string; ttlSeconds?: number; note?: string }): Promise<{ token: string; expiresAt: string; tenantId: string }> {
    return json('POST', joinUrl(this.adminBase(), `/admin/tenants/${tenantId}/invites`), data, this.adminHeaders());
  }

  async rotateKey(tenantId: string, agentId: string, data: {
    oldDid: string;
    newDid: string;
    newPublicKey: string;
    nonce: string;
    signature: string;
  }): Promise<{
    jwt: string;
    cid: string;
    expiresAt: string;
    newDid: string;
    revokedCids: string[];
    trustTier: number;
    allowedSkills: string[];
  }> {
    return json(
      'POST',
      joinUrl(this.adminBase(), `/admin/tenants/${tenantId}/agents/${agentId}/rotate-key`),
      data,
    );
  }

  async reissueUcan(tenantId: string, agentId: string, opts: { expiryDays?: number } = {}): Promise<{
    status: 'reissued';
    tenantId: string;
    agentId: string;
    expiresAt: string;
    cid: string;
    trustTier: number;
    allowedSkills: string[];
    ucanRenewalUrl: string;
    nextStep: string;
  }> {
    return json(
      'POST',
      joinUrl(this.adminBase(), `/admin/tenants/${tenantId}/agents/${agentId}/ucans/reissue`),
      opts.expiryDays !== undefined ? { expiryDays: opts.expiryDays } : {},
      this.adminHeaders(),
    );
  }

  private adminBase(): string {
    return this.opts.adminUrl ?? this.opts.novaUrl;
  }

  private adminHeaders(): Record<string, string> {
    return this.opts.adminToken ? { authorization: `Bearer ${this.opts.adminToken}` } : {};
  }
}
