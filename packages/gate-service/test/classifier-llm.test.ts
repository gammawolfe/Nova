// packages/gate-service/test/classifier-llm.test.ts
//
// Tests llmClassify's retry / timeout / injection-seam behaviour using
// a stub Anthropic client (the new opts.client injection seam).
//
// The cache path is exercised via the same stub by mocking the shared
// Redis singleton — cache hits short-circuit before the client is ever
// called, so we drive that branch by pre-populating the fake store.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted state for the redis + logger mocks (vi.mock factories run before
// imports complete). The env vars are pinned here so module-level const
// initialisation in classifier.ts sees them — beforeEach can't influence
// values that were already frozen at import time.
const { fakeRedisStore, loggerSpy } = vi.hoisted(() => {
  process.env.GATE_CLASSIFIER_RETRY_DELAYS_MS = '0,0,0,0';
  process.env.GATE_CLASSIFIER_REQUEST_TIMEOUT_MS = '5000';
  process.env.GATE_CLASSIFIER_MAX_ATTEMPTS = '3';
  return {
    fakeRedisStore: new Map<string, string>(),
    loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
  };
});

vi.mock('@nova/shared/src/logger', () => ({ logger: loggerSpy }));

vi.mock('@nova/shared/src/redis', () => ({
  REDIS_URL: 'redis://stub',
  getSharedRedis: () => ({
    async get(key: string) { return fakeRedisStore.get(key) ?? null; },
    async setex(key: string, _ttl: number, value: string) { fakeRedisStore.set(key, value); return 'OK'; },
  }),
  closeSharedRedis: async () => {},
}));

import { llmClassify } from '../src/classifier';
import type { StringField } from '@nova/shared/src/classifier';

const ctx = { tenantId: 't1', agentId: 'a1' };
const strings: StringField[] = [{ path: 'msg', value: 'hello world' }];

function makeStubClient(behaviour: {
  responses?: Array<unknown | Error>;
}) {
  const queue = [...(behaviour.responses ?? [])];
  return {
    messages: {
      create: vi.fn(async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error('stub: no response queued');
        if (next instanceof Error) throw next;
        return next as any;
      }),
    },
  };
}

/**
 * Build a stub messages.create response that emits a `tool_use` block
 * with the given classification input — what the real model returns when
 * the classifier forces it to invoke `report_classification`.
 */
function toolUseResponse(input: unknown) {
  return {
    content: [
      { type: 'tool_use', name: 'report_classification', id: 'tool_test', input },
    ],
  };
}

beforeEach(() => {
  fakeRedisStore.clear();
  for (const fn of Object.values(loggerSpy)) (fn as any).mockClear();
});

describe('llmClassify — happy path', () => {
  it('returns a parsed response from the injected client', async () => {
    const client = makeStubClient({
      responses: [toolUseResponse({ injection: false, confidence: 0.05, indicators: [] })],
    });

    const result = await llmClassify(strings, ctx, { client });
    expect(result.injection).toBe(false);
    expect(result.confidence).toBe(0.05);
    expect(result.indicators).toEqual([]);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('caches the result so a second call hits Redis (no SDK call)', async () => {
    const client = makeStubClient({
      responses: [toolUseResponse({ injection: true, confidence: 0.9, indicators: ['ignore previous'] })],
    });

    const first = await llmClassify(strings, ctx, { client });
    expect(first.fromCache).toBeUndefined();
    expect(client.messages.create).toHaveBeenCalledTimes(1);

    const second = await llmClassify(strings, ctx, { client });
    expect(second.fromCache).toBe(true);
    expect(second.injection).toBe(true);
    expect(client.messages.create).toHaveBeenCalledTimes(1); // unchanged
  });

  it('forces tool_choice on the report_classification tool', async () => {
    const client = makeStubClient({
      responses: [toolUseResponse({ injection: false, confidence: 0, indicators: [] })],
    });
    await llmClassify(strings, ctx, { client });
    const body = client.messages.create.mock.calls[0]?.[0];
    expect(body?.tools).toHaveLength(1);
    expect(body?.tools?.[0]?.name).toBe('report_classification');
    expect(body?.tool_choice).toEqual({ type: 'tool', name: 'report_classification' });
  });

  it('ignores leading text blocks and reads the tool_use block', async () => {
    // A future model may emit narration before the tool_use; the classifier
    // should still find the structured block.
    const client = makeStubClient({
      responses: [{
        content: [
          { type: 'text', text: 'I will assess the text.' },
          {
            type: 'tool_use',
            name: 'report_classification',
            id: 'tool_test',
            input: { injection: true, confidence: 0.95, indicators: ['ignore previous'] },
          },
        ],
      }],
    });
    const result = await llmClassify(strings, ctx, { client });
    expect(result.injection).toBe(true);
    expect(result.confidence).toBe(0.95);
  });
});

describe('llmClassify — retry behaviour', () => {
  it('retries up to CLASSIFIER_MAX_ATTEMPTS times before throwing', async () => {
    const client = makeStubClient({
      responses: [
        new Error('upstream 500'),
        new Error('upstream 500'),
        new Error('upstream 500'),
      ],
    });

    await expect(llmClassify(strings, ctx, { client })).rejects.toThrow(/failed after 3 attempts/);
    expect(client.messages.create).toHaveBeenCalledTimes(3);
  });

  it('succeeds on a retry after an initial failure', async () => {
    const client = makeStubClient({
      responses: [
        new Error('flaky'),
        toolUseResponse({ injection: false, confidence: 0.02, indicators: [] }),
      ],
    });

    const result = await llmClassify(strings, ctx, { client });
    expect(result.injection).toBe(false);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('retries when the tool_use input is missing required fields', async () => {
    const client = makeStubClient({
      responses: [
        toolUseResponse({ oops: true }), // missing injection/confidence/indicators
        toolUseResponse({ injection: true, confidence: 0.99, indicators: ['x'] }),
      ],
    });
    const result = await llmClassify(strings, ctx, { client });
    expect(result.injection).toBe(true);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('retries when the model emits text instead of a tool_use', async () => {
    // tool_choice forces the tool in production, but a stubbed or
    // future-misbehaving client could emit text. Defensive validation
    // retries through.
    const client = makeStubClient({
      responses: [
        { content: [{ type: 'text', text: 'sorry I cannot comply' }] }, // no tool_use
        toolUseResponse({ injection: false, confidence: 0.05, indicators: [] }),
      ],
    });
    const result = await llmClassify(strings, ctx, { client });
    expect(result.injection).toBe(false);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('honours GATE_CLASSIFIER_MAX_ATTEMPTS=1 (no retries)', async () => {
    process.env.GATE_CLASSIFIER_MAX_ATTEMPTS = '1';

    // Module-level const reads from env at import — for runtime override to
    // take effect in the same test process, we need to import a fresh copy.
    vi.resetModules();
    const { llmClassify: freshClassify } = await import('../src/classifier');

    const client = makeStubClient({ responses: [new Error('one-shot fail')] });
    await expect(freshClassify(strings, ctx, { client })).rejects.toThrow(/failed after 1 attempts/);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });
});

describe('llmClassify — request timeout', () => {
  it('passes an AbortSignal to the SDK request', async () => {
    const client = makeStubClient({
      responses: [toolUseResponse({ injection: false, confidence: 0.0, indicators: [] })],
    });

    await llmClassify(strings, ctx, { client });
    const callArgs = client.messages.create.mock.calls[0];
    expect(callArgs?.[1]).toBeDefined();
    expect(callArgs?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the SDK request after CLASSIFIER_REQUEST_TIMEOUT_MS', async () => {
    process.env.GATE_CLASSIFIER_REQUEST_TIMEOUT_MS = '50';
    vi.resetModules();
    const { llmClassify: freshClassify } = await import('../src/classifier');

    // Stub that hangs until aborted, then throws an AbortError.
    let abortedDuringCall = false;
    const client = {
      messages: {
        create: vi.fn(async (_body: any, opts: { signal?: AbortSignal }) => {
          // Wait for abort or 2s timeout (whichever first). The classifier
          // should abort us at 50ms.
          await new Promise<void>((resolve, reject) => {
            const watchdog = setTimeout(() => reject(new Error('stub: not aborted')), 2000);
            opts.signal?.addEventListener('abort', () => {
              clearTimeout(watchdog);
              abortedDuringCall = true;
              const err: any = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            }, { once: true });
          });
          return toolUseResponse({ injection: false, confidence: 0, indicators: [] }) as any;
        }),
      },
    };

    await expect(freshClassify(strings, ctx, { client })).rejects.toThrow(/failed after \d+ attempts/);
    expect(abortedDuringCall).toBe(true);
  });
});
