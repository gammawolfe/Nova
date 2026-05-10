// packages/shared/test/agent-index.test.ts
//
// Unit tests for the agent-index helpers, focused on the cross-tenant
// agentId collision guard. Nova's protocol exposes agents at
// /agents/:agentId/... with no tenantId in the URL, so an agentId must be
// unique within a Nova; two tenants cannot both claim the same id.

import { describe, it, expect, vi } from 'vitest';
import type IORedis from 'ioredis';
import {
  indexAgentMeta,
  AgentIdConflictError,
  agentIndexKey,
  agentMetaKey,
  didIndexKey,
  AGENT_REGISTRY_SET,
} from '../src/agent-index';

interface FakeState {
  strings: Map<string, string>;
  hashes: Map<string, Map<string, string>>;
  sets: Map<string, Set<string>>;
  pipelineCalls: Array<{ method: string; args: unknown[] }>;
}

function makeRedis(initial: Partial<FakeState> = {}): { redis: IORedis; state: FakeState } {
  const state: FakeState = {
    strings: initial.strings ?? new Map(),
    hashes: initial.hashes ?? new Map(),
    sets: initial.sets ?? new Map(),
    pipelineCalls: [],
  };

  // The pipeline only needs to record the calls we care about and run them
  // synchronously — indexAgentMeta does not branch on individual return
  // values, only on the SETNX-like read above.
  const pipeline = {
    set(key: string, value: string) {
      state.pipelineCalls.push({ method: 'set', args: [key, value] });
      state.strings.set(key, value);
      return pipeline;
    },
    hset(key: string, fields: Record<string, string>) {
      state.pipelineCalls.push({ method: 'hset', args: [key, fields] });
      const existing = state.hashes.get(key) ?? new Map();
      for (const [k, v] of Object.entries(fields)) existing.set(k, v);
      state.hashes.set(key, existing);
      return pipeline;
    },
    sadd(key: string, member: string) {
      state.pipelineCalls.push({ method: 'sadd', args: [key, member] });
      const existing = state.sets.get(key) ?? new Set();
      existing.add(member);
      state.sets.set(key, existing);
      return pipeline;
    },
    async exec() {
      return [] as Array<[Error | null, unknown]>;
    },
  };

  const redis = {
    get: vi.fn(async (key: string) => state.strings.get(key) ?? null),
    pipeline: vi.fn(() => pipeline),
  } as unknown as IORedis;

  return { redis, state };
}

const baseConfig = {
  agentId: 'claude-code',
  tenantId: 'household',
  name: 'My Claude Code',
  status: 'active',
  skills: [{ id: 'send', name: 'Send', description: 'Send tasks' }],
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  did: 'did:key:z6MkAlice',
};

describe('indexAgentMeta', () => {
  it('writes index, meta, registry, and did-index when the agentId is unclaimed', async () => {
    const { redis, state } = makeRedis();
    await indexAgentMeta(redis, baseConfig);

    expect(state.strings.get(agentIndexKey('claude-code'))).toBe('household');
    expect(state.hashes.get(agentMetaKey('claude-code'))?.get('tenantId')).toBe('household');
    expect(state.sets.get(AGENT_REGISTRY_SET)?.has('claude-code')).toBe(true);
    expect(state.strings.get(didIndexKey('did:key:z6MkAlice'))).toBe('claude-code');
  });

  it('is idempotent when the same tenant re-indexes (status update path)', async () => {
    const { redis, state } = makeRedis();
    await indexAgentMeta(redis, { ...baseConfig, status: 'pending' });
    await indexAgentMeta(redis, { ...baseConfig, status: 'active' });

    expect(state.strings.get(agentIndexKey('claude-code'))).toBe('household');
    expect(state.hashes.get(agentMetaKey('claude-code'))?.get('status')).toBe('active');
  });

  it('throws AgentIdConflictError when another tenant already owns the agentId', async () => {
    const { redis } = makeRedis({
      strings: new Map([[agentIndexKey('claude-code'), 'aunts-house']]),
    });

    await expect(indexAgentMeta(redis, baseConfig))
      .rejects.toBeInstanceOf(AgentIdConflictError);

    try {
      await indexAgentMeta(redis, baseConfig);
    } catch (err) {
      expect(err).toBeInstanceOf(AgentIdConflictError);
      const conflict = err as AgentIdConflictError;
      expect(conflict.status).toBe(409);
      expect(conflict.code).toBe('AGENT_EXISTS_OTHER_TENANT');
      expect(conflict.agentId).toBe('claude-code');
      expect(conflict.existingTenantId).toBe('aunts-house');
      expect(conflict.attemptedTenantId).toBe('household');
    }
  });

  it('does not write any keys when rejecting a cross-tenant collision', async () => {
    const { redis, state } = makeRedis({
      strings: new Map([[agentIndexKey('claude-code'), 'aunts-house']]),
    });
    const initialPipelineCalls = state.pipelineCalls.length;

    await expect(indexAgentMeta(redis, baseConfig)).rejects.toThrow();

    // The pipeline must not have been built, let alone exec'd.
    expect(state.pipelineCalls.length).toBe(initialPipelineCalls);
    // The original tenant's claim is intact.
    expect(state.strings.get(agentIndexKey('claude-code'))).toBe('aunts-house');
  });

  it('allows re-claim by the same tenant after deindex (key absent)', async () => {
    // Simulates: tenant A registers, deregisters (which deletes agent-index),
    // then re-registers. The key is absent at re-claim time, so the guard
    // does not fire.
    const { redis, state } = makeRedis();
    await indexAgentMeta(redis, baseConfig);
    state.strings.delete(agentIndexKey('claude-code'));

    await expect(indexAgentMeta(redis, baseConfig)).resolves.toBeUndefined();
    expect(state.strings.get(agentIndexKey('claude-code'))).toBe('household');
  });

  it('allows another tenant to claim an agentId once the prior owner deindexes', async () => {
    // tenant A registers, then deindex deletes the index → tenant B can claim.
    const { redis, state } = makeRedis();
    await indexAgentMeta(redis, baseConfig);
    state.strings.delete(agentIndexKey('claude-code'));

    await expect(
      indexAgentMeta(redis, { ...baseConfig, tenantId: 'aunts-house', did: 'did:key:z6MkBob' })
    ).resolves.toBeUndefined();

    expect(state.strings.get(agentIndexKey('claude-code'))).toBe('aunts-house');
  });
});
