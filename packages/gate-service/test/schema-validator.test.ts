import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// Hold the temp data root so the vi.mock factory can read it lazily.
const state: { dataRoot: string } = { dataRoot: '' };

vi.mock('@nova/shared/src/tenant', async () => {
  const actual = await vi.importActual<typeof import('@nova/shared/src/tenant')>('@nova/shared/src/tenant');
  return {
    ...actual,
    // tenantDataPath consumed by the schema validator — point it under our temp dir.
    tenantDataPath: (ctx: { tenantId: string; agentId: string }, ...parts: string[]) =>
      path.join(state.dataRoot, 'tenants', ctx.tenantId, 'agents', ctx.agentId, ...parts),
  };
});

import { validateSchema, invalidateAgentConfigCache } from '../src/schema-validator';

const ctx = { tenantId: 't1', agentId: 'a1' };

const FAR_FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

const validTask = {
  id: '11111111-1111-1111-1111-111111111111',
  schemaVersion: '1.0' as const,
  intent: 'chat',
  params: { message: 'hi' },
  ttl: FAR_FUTURE,
  idempotencyKey: '22222222-2222-2222-2222-222222222222',
};

async function writeAgentConfig(skills: unknown[]): Promise<void> {
  const dir = path.join(state.dataRoot, 'tenants', ctx.tenantId, 'agents', ctx.agentId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'agent-config.json'), JSON.stringify({ skills }));
}

beforeAll(async () => {
  state.dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gate-schema-test-'));
});

afterAll(async () => {
  await fsp.rm(state.dataRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Wipe any agent-config left by a previous case so each test sets its own.
  // Also invalidate the in-process config cache so the previous case's
  // cached entry doesn't bleed into this one.
  const dir = path.join(state.dataRoot, 'tenants', ctx.tenantId, 'agents', ctx.agentId);
  await fsp.rm(dir, { recursive: true, force: true });
  invalidateAgentConfigCache(ctx);
});

describe('validateSchema', () => {
  it('accepts a well-formed task with a known intent', async () => {
    await writeAgentConfig([
      { id: 'chat', name: 'Chat', inputSchema: { required: ['message'] }, outputSchema: {} },
    ]);
    const r = await validateSchema(validTask, ctx);
    expect(r.valid).toBe(true);
    expect(r.parsedTask).toMatchObject({ intent: 'chat' });
  });

  it('rejects a task with a top-level structural error', async () => {
    await writeAgentConfig([{ id: 'chat', name: 'Chat', inputSchema: {}, outputSchema: {} }]);
    const r = await validateSchema({ ...validTask, intent: 123 as unknown as string }, ctx);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/^schema_invalid:/);
  });

  it('rejects a task whose TTL has already expired', async () => {
    await writeAgentConfig([{ id: 'chat', name: 'Chat', inputSchema: {}, outputSchema: {} }]);
    const r = await validateSchema({ ...validTask, ttl: PAST }, ctx);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('task_ttl_expired_at_ingress');
  });

  it('rejects when the agent-config file is missing', async () => {
    const r = await validateSchema(validTask, ctx);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('schema_invalid:agent_config_unavailable');
  });

  it('rejects an intent that is not a declared skill', async () => {
    await writeAgentConfig([{ id: 'other-skill', name: 'X', inputSchema: {}, outputSchema: {} }]);
    const r = await validateSchema(validTask, ctx);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('intent_unknown');
  });

  it("rejects when a required param is missing per the skill's inputSchema", async () => {
    await writeAgentConfig([
      { id: 'chat', name: 'Chat', inputSchema: { required: ['message'] }, outputSchema: {} },
    ]);
    const r = await validateSchema({ ...validTask, params: {} }, ctx);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('schema_invalid:params.message_required');
  });

  it('accepts when inputSchema declares no required fields', async () => {
    await writeAgentConfig([
      { id: 'chat', name: 'Chat', inputSchema: {}, outputSchema: {} },
    ]);
    const r = await validateSchema({ ...validTask, params: {} }, ctx);
    expect(r.valid).toBe(true);
  });
});

describe('validateSchema — agent-config cache', () => {
  // Validates the 30s in-process TTL cache. After the first call seeds
  // the cache, deleting the file on disk must NOT cause the next call
  // (within TTL) to fail — the cached copy wins. Invalidation then
  // forces a fresh disk read which now misses.

  it('keeps validating after the on-disk file is deleted (cached)', async () => {
    await writeAgentConfig([
      { id: 'chat', name: 'Chat', inputSchema: {}, outputSchema: {} },
    ]);

    const first = await validateSchema(validTask, ctx);
    expect(first.valid).toBe(true);

    // Wipe the on-disk file. The cached entry should still answer.
    await fsp.rm(
      path.join(state.dataRoot, 'tenants', ctx.tenantId, 'agents', ctx.agentId, 'agent-config.json'),
    );

    const second = await validateSchema(validTask, ctx);
    expect(second.valid).toBe(true);
  });

  it('invalidateAgentConfigCache forces a disk re-read', async () => {
    await writeAgentConfig([
      { id: 'chat', name: 'Chat', inputSchema: {}, outputSchema: {} },
    ]);

    const first = await validateSchema(validTask, ctx);
    expect(first.valid).toBe(true);

    await fsp.rm(
      path.join(state.dataRoot, 'tenants', ctx.tenantId, 'agents', ctx.agentId, 'agent-config.json'),
    );
    invalidateAgentConfigCache(ctx);

    // After invalidation, the disk-missing path should surface.
    const second = await validateSchema(validTask, ctx);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('schema_invalid:agent_config_unavailable');
  });

  it('cache entries are keyed per (tenantId, agentId) — independent', async () => {
    // Seed t1/a1 with chat skill.
    await writeAgentConfig([
      { id: 'chat', name: 'Chat', inputSchema: {}, outputSchema: {} },
    ]);
    const r1 = await validateSchema(validTask, ctx);
    expect(r1.valid).toBe(true);

    // t2/a2 has no config on disk — should fail, regardless of t1/a1's cache.
    const otherCtx = { tenantId: 't2', agentId: 'a2' };
    const r2 = await validateSchema(validTask, otherCtx);
    expect(r2.valid).toBe(false);
    expect(r2.reason).toBe('schema_invalid:agent_config_unavailable');
  });
});
