import { describe, expect, it } from 'vitest';
import { codexCliHandlerFactory } from '../src/handlers/codex-cli';
import type { QueuedTask } from '@nova/shared/src/types';

function mkTask(senderAgentId = 'claude-code'): QueuedTask {
  return {
    taskId: '22222222-2222-4222-8222-222222222222',
    tenantId: 'tenant-1',
    agentId: 'codex',
    intent: 'answer_code_question',
    params: { question: 'What is Nova?' },
    senderTenantId: 'tenant-1',
    senderAgentId,
    senderDid: 'did:key:z6sender',
    tier: 1,
    queuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe('codex-cli handler policy', () => {
  it('does not spawn live Codex unless explicitly enabled', async () => {
    const handler = await codexCliHandlerFactory({});
    const result = await handler.handle(mkTask(), { logger: console } as any);

    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'LLM_REQUIRES_APPROVAL',
        retryable: false,
      },
    });
  });

  it('denies senders outside the allowedSenderAgents list before spawning', async () => {
    const handler = await codexCliHandlerFactory({
      mode: 'receiver-policy',
      allowedSenderAgents: ['trusted-agent'],
    });
    const result = await handler.handle(mkTask('claude-code'), { logger: console } as any);

    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'LLM_SENDER_DENIED',
        retryable: false,
      },
    });
  });
});
