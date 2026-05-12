// packages/task-queue/test/reply-delivery.test.ts
//
// Covers the deliverReply routing matrix and its failure-mode handling:
//   webhook ok                  → reply_delivered audit, returns webhook_delivered
//   webhook throws              → DLQ + reply_webhook_failed audit
//   webhook 5xx                 → DLQ + reply_webhook_failed audit (non-2xx is a failure)
//   broker, sender active       → enqueueReply + reply_broker_queued audit
//   broker, sender inactive     → DLQ + reply_sender_inactive audit
//   broker, sender missing      → same as inactive
//   broker, enqueue throws      → returns broker_enqueue_failed; no DLQ
//   neither replyTo nor sender  → returns no_target; warn logged

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskResult } from '@nova/shared/src/types';

// Hoisted mocks for everything deliverReply depends on. Each one returns a
// stub controllable from inside tests.

const auditMock = vi.fn();
const writeDeadLetterMock = vi.fn();
const enqueueReplyMock = vi.fn();
const getAgentMetaMock = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();

vi.mock('@nova/shared/src/audit', () => ({
  auditLog: (...args: unknown[]) => auditMock(...args),
}));

vi.mock('../src/dead-letter', () => ({
  writeDeadLetter: (...args: unknown[]) => writeDeadLetterMock(...args),
}));

vi.mock('../src/reply-inbox', () => ({
  enqueueReply: (...args: unknown[]) => enqueueReplyMock(...args),
}));

vi.mock('@nova/shared/src/agent-index', () => ({
  getAgentMeta: (...args: unknown[]) => getAgentMetaMock(...args),
}));

vi.mock('@nova/shared/src/redis', () => ({
  getSharedRedis: () => ({}),
}));

vi.mock('@nova/shared/src/logger', () => ({
  logger: {
    info: () => {},
    warn: (...args: unknown[]) => loggerWarn(...args),
    error: (...args: unknown[]) => loggerError(...args),
    debug: () => {},
  },
}));

import { deliverReply } from '../src/reply-delivery';

const recipientCtx = { tenantId: 't-recipient', agentId: 'a-recipient' };
const senderCtx = { tenantId: 't-sender', agentId: 'a-sender' };

function makeResult(): TaskResult {
  return {
    type: 'TaskResult',
    requestId: 'task-1',
    status: 'ok',
    result: { ok: true },
    auditToken: 'none',
    completedAt: '2026-05-12T00:00:00.000Z',
    schemaVersion: '1.0',
  };
}

beforeEach(() => {
  auditMock.mockReset();
  writeDeadLetterMock.mockReset();
  enqueueReplyMock.mockReset();
  getAgentMetaMock.mockReset();
  loggerWarn.mockReset();
  loggerError.mockReset();
});

describe('deliverReply — webhook branch', () => {
  it('returns webhook_delivered on 2xx and emits reply_delivered audit', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as any;

    const outcome = await deliverReply('task-1', makeResult(), {
      replyTo: 'https://example/hook',
      recipientCtx,
    });

    expect(outcome).toBe('webhook_delivered');
    expect(auditMock).toHaveBeenCalledWith(recipientCtx, expect.objectContaining({
      event: 'reply_delivered',
      taskId: 'task-1',
      metadata: { target: 'webhook' },
    }));
    expect(writeDeadLetterMock).not.toHaveBeenCalled();
  });

  it('DLQs and emits reply_webhook_failed when fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;

    const outcome = await deliverReply('task-1', makeResult(), {
      replyTo: 'https://example/hook',
      recipientCtx,
      senderTenantId: senderCtx.tenantId,
      senderAgentId: senderCtx.agentId,
    });

    expect(outcome).toBe('webhook_failed_dlq');
    // DLQ goes to the sender's ctx when known — operator inspecting the
    // sender's DLQ folder finds the undelivered result.
    expect(writeDeadLetterMock).toHaveBeenCalledWith(senderCtx, expect.objectContaining({
      taskId: 'task-1',
      targetUrl: 'https://example/hook',
      failureReason: 'reply_webhook_failed',
    }));
    expect(auditMock).toHaveBeenCalledWith(recipientCtx, expect.objectContaining({
      event: 'reply_webhook_failed',
      taskId: 'task-1',
    }));
  });

  it('treats non-2xx as a delivery failure (was silently swallowed pre-fix)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 500 })) as any;

    const outcome = await deliverReply('task-1', makeResult(), {
      replyTo: 'https://example/hook',
      recipientCtx,
      senderTenantId: senderCtx.tenantId,
      senderAgentId: senderCtx.agentId,
    });

    expect(outcome).toBe('webhook_failed_dlq');
    expect(writeDeadLetterMock).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(recipientCtx, expect.objectContaining({
      event: 'reply_webhook_failed',
    }));
  });

  it('DLQs to recipient ctx when sender ctx is unknown', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('boom'); }) as any;

    await deliverReply('task-1', makeResult(), {
      replyTo: 'https://example/hook',
      recipientCtx,
      // No sender ctx — the result still has to land somewhere, so it
      // goes to the recipient's DLQ.
    });

    expect(writeDeadLetterMock).toHaveBeenCalledWith(recipientCtx, expect.objectContaining({
      failureReason: 'reply_webhook_failed',
    }));
  });

  it('reuses pre-serialized result body when caller provides it', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchSpy as any;

    const preSerialized = '{"pre":"serialized"}';
    await deliverReply('task-1', makeResult(), {
      replyTo: 'https://example/hook',
      recipientCtx,
      serializedResult: preSerialized,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example/hook',
      expect.objectContaining({ body: preSerialized }),
    );
  });
});

describe('deliverReply — broker branch', () => {
  it('enqueues to sender reply-inbox and emits reply_broker_queued when sender active', async () => {
    getAgentMetaMock.mockResolvedValue({ ...senderCtx, status: 'active', did: 'did:key:abc' });
    enqueueReplyMock.mockResolvedValue(undefined);

    const outcome = await deliverReply('task-1', makeResult(), {
      recipientCtx,
      senderTenantId: senderCtx.tenantId,
      senderAgentId: senderCtx.agentId,
    });

    expect(outcome).toBe('broker_queued');
    expect(enqueueReplyMock).toHaveBeenCalledWith(senderCtx, 'task-1', expect.any(Object));
    expect(auditMock).toHaveBeenCalledWith(recipientCtx, expect.objectContaining({
      event: 'reply_broker_queued',
      taskId: 'task-1',
    }));
    expect(writeDeadLetterMock).not.toHaveBeenCalled();
  });

  it('DLQs to sender when sender is inactive', async () => {
    getAgentMetaMock.mockResolvedValue({ ...senderCtx, status: 'deregistered' });

    const outcome = await deliverReply('task-1', makeResult(), {
      recipientCtx,
      senderTenantId: senderCtx.tenantId,
      senderAgentId: senderCtx.agentId,
    });

    expect(outcome).toBe('broker_sender_inactive_dlq');
    expect(writeDeadLetterMock).toHaveBeenCalledWith(senderCtx, expect.objectContaining({
      failureReason: 'reply_sender_inactive',
      targetUrl: 'broker-reply',
    }));
    expect(auditMock).toHaveBeenCalledWith(recipientCtx, expect.objectContaining({
      event: 'reply_sender_inactive',
    }));
    expect(enqueueReplyMock).not.toHaveBeenCalled();
  });

  it('treats sender missing from index as inactive', async () => {
    getAgentMetaMock.mockResolvedValue(null);

    const outcome = await deliverReply('task-1', makeResult(), {
      recipientCtx,
      senderTenantId: senderCtx.tenantId,
      senderAgentId: senderCtx.agentId,
    });

    expect(outcome).toBe('broker_sender_inactive_dlq');
    expect(writeDeadLetterMock).toHaveBeenCalled();
  });

  it('returns broker_enqueue_failed (no DLQ) when enqueueReply throws', async () => {
    getAgentMetaMock.mockResolvedValue({ ...senderCtx, status: 'active', did: 'did:key:abc' });
    enqueueReplyMock.mockRejectedValue(new Error('redis down'));

    const outcome = await deliverReply('task-1', makeResult(), {
      recipientCtx,
      senderTenantId: senderCtx.tenantId,
      senderAgentId: senderCtx.agentId,
    });

    expect(outcome).toBe('broker_enqueue_failed');
    // Intentional: transient enqueue failures don't DLQ — the sender's
    // idempotent resubmit redrives the whole task.
    expect(writeDeadLetterMock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalled();
  });
});

describe('deliverReply — no-target branch', () => {
  it('returns no_target and warns when neither replyTo nor sender is set', async () => {
    const outcome = await deliverReply('task-1', makeResult(), { recipientCtx });

    expect(outcome).toBe('no_target');
    expect(loggerWarn).toHaveBeenCalled();
    expect(writeDeadLetterMock).not.toHaveBeenCalled();
    expect(enqueueReplyMock).not.toHaveBeenCalled();
  });

  it('webhook takes precedence over broker when both are present', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as any;

    const outcome = await deliverReply('task-1', makeResult(), {
      recipientCtx,
      replyTo: 'https://example/hook',
      senderTenantId: senderCtx.tenantId,
      senderAgentId: senderCtx.agentId,
    });

    expect(outcome).toBe('webhook_delivered');
    expect(enqueueReplyMock).not.toHaveBeenCalled();
    expect(getAgentMetaMock).not.toHaveBeenCalled();
  });
});
