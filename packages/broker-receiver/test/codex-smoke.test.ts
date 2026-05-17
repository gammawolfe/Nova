import { describe, expect, it } from 'vitest';
import { codexSmokeHandlerFactory } from '../src/handlers/codex-smoke';
import type { QueuedTask } from '@nova/shared/src/types';

function mkTask(intent: string, params: Record<string, unknown>): QueuedTask {
  return {
    taskId: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tenant-1',
    agentId: 'codex',
    intent,
    params,
    senderTenantId: 'tenant-1',
    senderAgentId: 'claude-code',
    senderDid: 'did:key:z6sender',
    tier: 1,
    queuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe('codex-smoke handler', () => {
  it('returns answer_code_question output shape', async () => {
    const handler = await codexSmokeHandlerFactory({});
    const result = await handler.handle(
      mkTask('answer_code_question', { question: 'What is 2+2?' }),
      {} as any,
    );

    expect(result).toEqual({
      status: 'ok',
      result: {
        answer: 'Received by codex-smoke via Nova broker inbox. 2+2 equals 4.',
      },
    });
  });

  it('returns review_code output shape', async () => {
    const handler = await codexSmokeHandlerFactory({});
    const result = await handler.handle(
      mkTask('review_code', { filePath: '/tmp/example.ts' }),
      {} as any,
    );

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.result).toMatchObject({
        findings: [],
      });
    }
  });

  it('rejects unsupported intents', async () => {
    const handler = await codexSmokeHandlerFactory({});
    const result = await handler.handle(mkTask('chat', { message: 'hello' }), {} as any);

    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'UNSUPPORTED_INTENT',
        retryable: false,
      },
    });
  });
});
