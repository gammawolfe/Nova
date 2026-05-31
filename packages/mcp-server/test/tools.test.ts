// packages/mcp-server/test/tools.test.ts
//
// Unit coverage for the consolidated MCP tool surface (src/tools.ts). The
// acceptance suite drives the a2a-server over HTTP and never executes this
// layer, so these offline tests are the only regression guard for action
// dispatch, forAction validation, the legacy flag, and watch routing.
//
// NOVA_HOME is redirected to a throwaway dir BEFORE importing tools.ts, because
// @nova/shared/src/paths.ts captures it at module load. All imports are dynamic
// for the same reason.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

const TEST_HOME = path.join(os.tmpdir(), 'nova-tools-test-' + randomBytes(4).toString('hex'));
process.env['NOVA_HOME'] = TEST_HOME;
delete process.env['NOVA_AGENT_ID'];
delete process.env['NOVA_ADMIN_TOKEN'];
delete process.env['NOVA_MCP_LEGACY_TOOLS'];
delete process.env['NOVA_URL'];

const { registerTools } = await import('../src/tools.js');
const { generateIdentity, saveIdentity } = await import('@nova/shared/src/identity.js');
const { saveTenantConfig } = await import('@nova/shared/src/tenant-config.js');
const { saveCache } = await import('@nova/shared/src/ucan-store.js');

const CONSOLIDATED = ['nova_identity', 'nova_onboard', 'nova_discover', 'nova_task', 'nova_inbox', 'nova_replies', 'nova_admin'];

type Captured = { tools: Record<string, { def: any; handler: Function }>; subCalls: string[] };

function build(opts: { legacy?: boolean; subs?: boolean } = {}): Captured {
  const tools: Record<string, { def: any; handler: Function }> = {};
  const server: any = { registerTool: (n: string, d: any, h: Function) => { tools[n] = { def: d, handler: h }; } };
  const subCalls: string[] = [];
  const fakeSubs: any = opts.subs
    ? {
        subscribe: async (u: string) => { subCalls.push('sub:' + u); },
        unsubscribe: async (u: string) => { subCalls.push('unsub:' + u); },
      }
    : undefined;

  const prev = process.env['NOVA_MCP_LEGACY_TOOLS'];
  if (opts.legacy) process.env['NOVA_MCP_LEGACY_TOOLS'] = '1';
  else delete process.env['NOVA_MCP_LEGACY_TOOLS'];
  registerTools(server, fakeSubs);
  if (prev === undefined) delete process.env['NOVA_MCP_LEGACY_TOOLS'];
  else process.env['NOVA_MCP_LEGACY_TOOLS'] = prev;

  return { tools, subCalls };
}

const text = (r: any): string => r.content[0].text;
const isErr = (r: any): boolean => r.isError === true;

describe('registration surface', () => {
  it('default (no flag) exposes exactly the 7 consolidated tools and no legacy', () => {
    const { tools } = build();
    const names = Object.keys(tools);
    expect(names.sort()).toEqual([...CONSOLIDATED].sort());
    expect(names).not.toContain('nova_send_task');
    expect(names).not.toContain('nova_watch_inbox');
  });

  it('legacy flag off stays at 7 even when a subscription manager is present', () => {
    const { tools } = build({ subs: true });
    expect(Object.keys(tools)).toHaveLength(7);
    expect(tools['nova_send_task']).toBeUndefined();
  });

  it('legacy flag on adds the full legacy surface (33 with subs)', () => {
    const { tools } = build({ legacy: true, subs: true });
    expect(Object.keys(tools)).toHaveLength(33);
    expect(tools['nova_send_task']).toBeDefined();
    expect(tools['nova_watch_inbox']).toBeDefined();
    // consolidated tools are still present alongside legacy
    for (const n of CONSOLIDATED) expect(tools[n]).toBeDefined();
  });

  it('legacy flag on without subs omits the watch/unwatch tools (27)', () => {
    const { tools } = build({ legacy: true });
    expect(Object.keys(tools)).toHaveLength(27);
    expect(tools['nova_send_task']).toBeDefined();
    expect(tools['nova_watch_inbox']).toBeUndefined();
  });
});

describe('action dispatch + validation', () => {
  const { tools, subCalls } = build({ subs: true });
  const call = (name: string, args: any) => tools[name].handler(args);

  it('rejects an unknown action with the valid list', async () => {
    const r = await call('nova_identity', { action: 'bogus' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('Unknown action');
  });

  it('routes nova_identity:whoami to the whoami op', async () => {
    const r = await call('nova_identity', { action: 'whoami' });
    expect(isErr(r)).toBe(false);
    expect(text(r)).toContain('activeAgentId');
  });

  it('routes nova_onboard:inspect_invite to the decoder (bad invite → Invalid invite)', async () => {
    const r = await call('nova_onboard', { action: 'inspect_invite', invite: 'not-a-jwt' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('Invalid invite');
  });

  it('routes nova_onboard:accept_invite and hits the novaUrl guard offline', async () => {
    const r = await call('nova_onboard', { action: 'accept_invite', invite: 'x' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('NOVA_URL');
  });

  it('forAction reports precise field errors for nova_task:result missing taskId', async () => {
    const r = await call('nova_task', { action: 'result', targetAgentId: 'a' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('Invalid params');
    expect(text(r)).toContain('taskId');
  });

  it('forAction rejects nova_onboard:register with missing required fields', async () => {
    const r = await call('nova_onboard', { action: 'register' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('Invalid params');
  });

  it('forAction enforces the respond refine (status=error requires error obj)', async () => {
    const r = await call('nova_inbox', { action: 'respond', taskId: '00000000-0000-0000-0000-000000000000', status: 'error' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('Invalid params');
  });

  it('forAction rejects a non-uuid taskId for nova_replies:ack', async () => {
    const r = await call('nova_replies', { action: 'ack', taskId: 'not-a-uuid' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('Invalid params');
  });

  it('passes brokerCtx guard errors through verbatim (nova_inbox:next, no runtime)', async () => {
    const r = await call('nova_inbox', { action: 'next' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toBe('No active agent runtime. Set NOVA_AGENT_ID.');
  });

  it('routes the send guard offline (nova_task:send, no runtime)', async () => {
    const r = await call('nova_task', { action: 'send', targetAgentId: 'x', intent: 'y', params: {} });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('No active agent runtime');
  });

  it('routes watch/unwatch actions to the subscription manager', async () => {
    await call('nova_task', { action: 'watch', taskId: 't1' });
    await call('nova_inbox', { action: 'watch' });
    await call('nova_replies', { action: 'unwatch' });
    expect(subCalls).toEqual(['sub:nova://tasks/t1', 'sub:nova://inbox', 'unsub:nova://replies']);
  });

  it('enforces the admin token guard (nova_admin:create_tenant)', async () => {
    const r = await call('nova_admin', { action: 'create_tenant', slug: 'abc', name: 'Abc' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('NOVA_ADMIN_TOKEN');
  });

  it('validates admin params before the token guard (bad slug)', async () => {
    const r = await call('nova_admin', { action: 'create_tenant', slug: 'BAD SLUG', name: 'x' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('Invalid params');
  });
});

describe('watch actions without a subscription manager degrade gracefully', () => {
  it('reports push unavailable instead of throwing', async () => {
    const { tools } = build(); // no subs
    const r = await tools['nova_inbox'].handler({ action: 'watch' });
    expect(isErr(r)).toBe(true);
    expect(text(r)).toContain('not available');
  });
});

describe('nova_identity:grant_status surfaces the operator-reissue renewal field', () => {
  beforeAll(async () => {
    process.env['NOVA_AGENT_ID'] = 'tester';
    await saveIdentity(generateIdentity('tester'));
    await saveTenantConfig({ novaUrl: 'http://localhost:3001', tenantId: 't_test', joinedAt: new Date().toISOString() });
    await saveCache({ agentId: 'tester', grant: { jwt: 'a.b.c', cid: 'bafytest', expiresAt: '2099-01-01T00:00:00.000Z' } });
  });
  afterAll(() => { delete process.env['NOVA_AGENT_ID']; });

  it('returns cid/expiry plus a structured operator_reissue_required renewal', async () => {
    const { tools } = build();
    const r = await tools['nova_identity'].handler({ action: 'grant_status' });
    expect(isErr(r)).toBe(false);
    const body = JSON.parse(text(r));
    expect(body.cid).toBe('bafytest');
    expect(body.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    expect(typeof body.lifetimeRemaining).toBe('number');
    expect(body.renewal.mode).toBe('operator_reissue_required');
    expect(body.renewal.remediation).toContain('reissue_grant');
  });
});
