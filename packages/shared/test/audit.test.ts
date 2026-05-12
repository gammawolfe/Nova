// packages/shared/test/audit.test.ts
//
// Unit tests for auditLog + the audit drain consumer. The redis dependency
// is injected directly (the production API accepts `redis` as an optional
// parameter for exactly this reason); no module-level vi.mock dance is
// needed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('@nova/shared/src/logger', () => ({
  logger: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
  },
}));

import {
  auditLog,
  startAuditLogConsumer,
  AUDIT_STREAM_KEY,
  AUDIT_CONSUMER_GROUP,
  AUDIT_DLQ_STREAM_KEY,
} from '../src/audit';
import type { TenantContext } from '../src/tenant';

// ── In-memory ioredis stub ─────────────────────────────────────────────────
//
// Covers exactly what auditLog + the consumer touch: xgroup CREATE,
// xreadgroup with BLOCK, xadd, xack. Streams are arrays; the group tracks
// its own '>' cursor + pending set per (stream, group).

interface StreamEntry { id: string; fields: string[] }

class FakeRedis {
  streams = new Map<string, StreamEntry[]>();
  groups = new Map<string, { lastDelivered: string; pending: Set<string> }>();
  private idCounter = 0;

  private nextId(): string {
    this.idCounter += 1;
    return `${Date.now()}-${this.idCounter}`;
  }

  async xgroup(_: string, key: string, group: string, _id: string, _mkstream: string) {
    const gKey = `${key}|${group}`;
    if (this.groups.has(gKey)) {
      throw new Error('BUSYGROUP Consumer Group name already exists');
    }
    this.groups.set(gKey, { lastDelivered: '0', pending: new Set() });
    if (!this.streams.has(key)) this.streams.set(key, []);
    return 'OK';
  }

  async xadd(key: string, _id: string, ...fields: string[]) {
    const id = this.nextId();
    const arr = this.streams.get(key) ?? [];
    arr.push({ id, fields });
    this.streams.set(key, arr);
    return id;
  }

  async xreadgroup(
    _g: 'GROUP', group: string, _consumer: string,
    _c: 'COUNT', _count: string,
    _b: 'BLOCK', blockMs: string,
    _s: 'STREAMS', key: string, _id: string,
  ) {
    const gKey = `${key}|${group}`;
    const groupState = this.groups.get(gKey);
    if (!groupState) return null;
    const arr = this.streams.get(key) ?? [];
    const undelivered = groupState.lastDelivered === '0'
      ? arr.filter(e => !groupState.pending.has(e.id))
      : arr.filter(e => e.id > groupState.lastDelivered);
    if (undelivered.length === 0) {
      await new Promise(r => setTimeout(r, Math.min(parseInt(blockMs, 10), 50)));
      return null;
    }
    const last = undelivered[undelivered.length - 1];
    if (last) groupState.lastDelivered = last.id;
    for (const e of undelivered) groupState.pending.add(e.id);
    return [[key, undelivered.map(e => [e.id, e.fields])]];
  }

  async xack(key: string, group: string, msgId: string) {
    const gKey = `${key}|${group}`;
    const groupState = this.groups.get(gKey);
    if (!groupState) return 0;
    return groupState.pending.delete(msgId) ? 1 : 0;
  }
}

let fakeRedis: FakeRedis;
let dataRoot: string;

beforeEach(async () => {
  fakeRedis = new FakeRedis();
  dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'audit-test-'));
});

afterEach(async () => {
  await fsp.rm(dataRoot, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('auditLog', () => {
  it('xadds a single `event` field — no redundant top-level fields', async () => {
    const ctx: TenantContext = { tenantId: 't1', agentId: 'a1' };
    await auditLog(
      ctx,
      { event: 'task_started', taskId: '550e8400-e29b-41d4-a716-446655440000' },
      fakeRedis as any,
    );

    const arr = fakeRedis.streams.get(AUDIT_STREAM_KEY) ?? [];
    expect(arr).toHaveLength(1);
    const fields = arr[0]!.fields;
    expect(fields).toHaveLength(2);
    expect(fields[0]).toBe('event');
    const parsed = JSON.parse(fields[1]!);
    expect(parsed.tenantId).toBe('t1');
    expect(parsed.agentId).toBe('a1');
    expect(parsed.event).toBe('task_started');
    expect(parsed.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('startAuditLogConsumer', () => {
  it('drains a valid event to JSONL and ACKs it', async () => {
    const abort = new AbortController();
    const consumerDone = startAuditLogConsumer(dataRoot, {
      signal: abort.signal,
      redis: fakeRedis as any,
    });

    await auditLog(
      { tenantId: 't1', agentId: 'a1' },
      { event: 'task_started', taskId: '550e8400-e29b-41d4-a716-446655440000' },
      fakeRedis as any,
    );

    await sleep(200);
    abort.abort();
    await consumerDone;

    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(dataRoot, 'audit', 't1', `audit-${today}.jsonl`);
    expect(fs.existsSync(logFile)).toBe(true);
    const content = await fsp.readFile(logFile, 'utf8');
    const line = JSON.parse(content.trim());
    expect(line.event).toBe('task_started');
    expect(line.tenantId).toBe('t1');

    const gKey = `${AUDIT_STREAM_KEY}|${AUDIT_CONSUMER_GROUP}`;
    expect(fakeRedis.groups.get(gKey)?.pending.size).toBe(0);
  });

  it('routes a malformed event to the DLQ stream and ACKs upstream', async () => {
    const abort = new AbortController();
    const consumerDone = startAuditLogConsumer(dataRoot, {
      signal: abort.signal,
      redis: fakeRedis as any,
    });

    // Inject malformed JSON directly.
    await fakeRedis.xadd(AUDIT_STREAM_KEY, '*', 'event', '{not valid json');

    await sleep(200);
    abort.abort();
    await consumerDone;

    const gKey = `${AUDIT_STREAM_KEY}|${AUDIT_CONSUMER_GROUP}`;
    expect(fakeRedis.groups.get(gKey)?.pending.size).toBe(0);

    const dlq = fakeRedis.streams.get(AUDIT_DLQ_STREAM_KEY) ?? [];
    expect(dlq).toHaveLength(1);
    const fields = dlq[0]!.fields;
    const fieldMap: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) fieldMap[fields[i]!] = fields[i + 1]!;
    expect(fieldMap.reason).toMatch(/parse-failed/);
    expect(fieldMap.originalFields).toContain('not valid json');
  });

  it('handles a message with no `event` field by DLQing it', async () => {
    const abort = new AbortController();
    const consumerDone = startAuditLogConsumer(dataRoot, {
      signal: abort.signal,
      redis: fakeRedis as any,
    });

    await fakeRedis.xadd(AUDIT_STREAM_KEY, '*', 'unrelated', 'noise');

    await sleep(200);
    abort.abort();
    await consumerDone;

    const dlq = fakeRedis.streams.get(AUDIT_DLQ_STREAM_KEY) ?? [];
    expect(dlq).toHaveLength(1);
    const fields = dlq[0]!.fields;
    const fieldMap: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) fieldMap[fields[i]!] = fields[i + 1]!;
    expect(fieldMap.reason).toBe('missing-event-field');
  });

  it('returns promptly when the abort signal is already fired', async () => {
    const abort = new AbortController();
    abort.abort();
    const t0 = Date.now();
    await startAuditLogConsumer(dataRoot, {
      signal: abort.signal,
      redis: fakeRedis as any,
    });
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('continues draining after a parse failure (loop does not stop)', async () => {
    const abort = new AbortController();
    const consumerDone = startAuditLogConsumer(dataRoot, {
      signal: abort.signal,
      redis: fakeRedis as any,
    });

    await fakeRedis.xadd(AUDIT_STREAM_KEY, '*', 'event', '{broken');
    await auditLog(
      { tenantId: 't1', agentId: 'a1' },
      { event: 'task_completed' },
      fakeRedis as any,
    );

    await sleep(250);
    abort.abort();
    await consumerDone;

    expect((fakeRedis.streams.get(AUDIT_DLQ_STREAM_KEY) ?? [])).toHaveLength(1);

    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(dataRoot, 'audit', 't1', `audit-${today}.jsonl`);
    const content = await fsp.readFile(logFile, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(1);
  });
});
