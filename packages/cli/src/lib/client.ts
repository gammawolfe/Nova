// packages/cli/src/lib/client.ts
//
// Thin HTTP client for the Nova admin API and a2a-server.
// Handles auth headers, error bodies, and streaming SSE.

import { CliConfig } from './config.js';

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T = unknown>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }

  if (!res.ok) {
    const msg = typeof parsed === 'object' && parsed !== null
      ? ((parsed as any).error ?? (parsed as any).message ?? text)
      : text;
    throw new ApiError(`${method} ${url} → ${res.status}: ${msg}`, res.status, parsed);
  }
  return parsed as T;
}

export class NovaAdminClient {
  private readonly adminBase: string;
  private readonly novaBase: string;
  private readonly token: string;

  constructor(config: CliConfig) {
    this.adminBase = config.adminUrl.replace(/\/$/, '');
    this.novaBase = config.novaUrl.replace(/\/$/, '');
    this.token = config.adminToken;
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  private admin(path: string): string {
    return joinUrl(this.adminBase, path);
  }

  private nova(path: string): string {
    return joinUrl(this.novaBase, path);
  }

  // ── System ────────────────────────────────────────────────────────────────

  async health(): Promise<unknown> {
    return request('GET', this.admin('/admin/health'), undefined, this.auth());
  }

  // ── Tenants ───────────────────────────────────────────────────────────────

  async listTenants(): Promise<any[]> {
    return request('GET', this.admin('/admin/tenants'), undefined, this.auth());
  }

  async getTenant(tenantId: string): Promise<any> {
    return request('GET', this.admin(`/admin/tenants/${tenantId}`), undefined, this.auth());
  }

  async createTenant(data: { name: string; slug: string; plan?: string }): Promise<any> {
    return request('POST', this.admin('/admin/tenants'), data, this.auth());
  }

  async deleteTenant(tenantId: string): Promise<any> {
    return request('DELETE', this.admin(`/admin/tenants/${tenantId}`), undefined, this.auth());
  }

  // ── Invites ───────────────────────────────────────────────────────────────

  async mintInvite(tenantId: string, data: { agentIdHint: string; ttlSeconds?: number; note?: string }): Promise<any> {
    return request('POST', this.admin(`/admin/tenants/${tenantId}/invites`), data, this.auth());
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  async listAgents(tenantId?: string): Promise<any[]> {
    if (tenantId) {
      return request('GET', this.admin(`/admin/tenants/${tenantId}/agents`), undefined, this.auth());
    }
    return request('GET', this.admin('/admin/agents'), undefined, this.auth());
  }

  async getAgent(tenantId: string, agentId: string): Promise<any> {
    return request('GET', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}`), undefined, this.auth());
  }

  async approveAgent(tenantId: string, agentId: string, data: {
    trustTier?: number;
    ucanExpiryDays?: number;
    allowedSkills?: string[];
    notes?: string;
  }): Promise<any> {
    return request('POST', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/approve`), data, this.auth());
  }

  async rejectAgent(tenantId: string, agentId: string): Promise<any> {
    return request('POST', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/reject`), {}, this.auth());
  }

  async deleteAgent(tenantId: string, agentId: string): Promise<any> {
    return request('DELETE', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}`), undefined, this.auth());
  }

  async reissueGrant(tenantId: string, agentId: string): Promise<any> {
    return request('POST', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/ucans/reissue`), {}, this.auth());
  }

  // ── Trust ─────────────────────────────────────────────────────────────────

  async listTrust(tenantId: string, agentId: string): Promise<any[]> {
    return request('GET', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/trust`), undefined, this.auth());
  }

  async revokeTrust(tenantId: string, agentId: string, did: string): Promise<any> {
    return request('DELETE', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/trust/${encodeURIComponent(did)}`), undefined, this.auth());
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  async queryAudit(tenantId: string, params: {
    event?: string;
    from?: string;
    to?: string;
    taskId?: string;
    limit?: number;
  } = {}): Promise<any[]> {
    const qs = new URLSearchParams();
    if (params.event) qs.set('event', params.event);
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.taskId) qs.set('taskId', params.taskId);
    if (params.limit) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return request('GET', this.admin(`/admin/tenants/${tenantId}/audit${q ? '?' + q : ''}`), undefined, this.auth());
  }

  async getTaskAudit(tenantId: string, taskId: string): Promise<any[]> {
    return request('GET', this.admin(`/admin/tenants/${tenantId}/audit/${taskId}`), undefined, this.auth());
  }

  // ── Quarantine ────────────────────────────────────────────────────────────

  async listQuarantine(tenantId: string, agentId: string): Promise<any[]> {
    return request('GET', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/quarantine`), undefined, this.auth());
  }

  async releaseQuarantine(tenantId: string, agentId: string, id: string): Promise<any> {
    return request('POST', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/quarantine/${id}/release`), {}, this.auth());
  }

  async dropQuarantine(tenantId: string, agentId: string, id: string): Promise<any> {
    return request('DELETE', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/quarantine/${id}`), undefined, this.auth());
  }

  async quarantineStats(tenantId: string, agentId: string): Promise<any> {
    return request('GET', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/quarantine/stats`), undefined, this.auth());
  }

  // ── Dead Letter ───────────────────────────────────────────────────────────

  async listDeadLetters(tenantId: string, agentId: string): Promise<any[]> {
    return request('GET', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/dead-letter`), undefined, this.auth());
  }

  async dropDeadLetter(tenantId: string, agentId: string, id: string): Promise<any> {
    return request('DELETE', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/dead-letter/${id}`), undefined, this.auth());
  }

  // ── Confirmation Queue ────────────────────────────────────────────────────

  async listConfirmQueue(tenantId: string, agentId: string): Promise<any[]> {
    return request('GET', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/confirm-queue`), undefined, this.auth());
  }

  async approveConfirm(tenantId: string, agentId: string, id: string): Promise<any> {
    return request('POST', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/confirm-queue/${id}`), { reviewedBy: 'nova-cli' }, this.auth());
  }

  async rejectConfirm(tenantId: string, agentId: string, id: string): Promise<any> {
    return request('DELETE', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/confirm-queue/${id}`), undefined, this.auth());
  }

  // ── Broker ────────────────────────────────────────────────────────────────

  async brokerSummary(): Promise<any> {
    return request('GET', this.admin('/admin/broker/summary'), undefined, this.auth());
  }

  async brokerStatus(tenantId: string, agentId: string): Promise<any> {
    return request('GET', this.admin(`/admin/tenants/${tenantId}/agents/${agentId}/broker-status`), undefined, this.auth());
  }

  // ── SSE event stream (raw, caller iterates) ───────────────────────────────

  eventsUrl(): string {
    // /admin/events is unauthenticated in the admin-api (v1 trust model)
    return this.admin('/admin/events');
  }
}
