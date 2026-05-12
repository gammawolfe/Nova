// packages/shared/test/redis.test.ts
//
// Smoke test that the shared redis singleton attaches an error listener.
// The listener body is a single logger.error call — we don't try to
// intercept that across the relative-import boundary (vi.mock vs `./logger`
// canonicalisation is fragile); just verify the listener exists and that
// invoking it doesn't throw.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { handlers, FakeIORedis } = vi.hoisted(() => {
  const handlers = new Map<string, (err: Error) => void>();
  class FakeIORedis {
    on(event: string, fn: (err: Error) => void): this {
      handlers.set(event, fn);
      return this;
    }
    quit() { return Promise.resolve('OK'); }
  }
  return { handlers, FakeIORedis };
});

vi.mock('ioredis', () => ({ default: FakeIORedis }));

import { getSharedRedis, closeSharedRedis } from '../src/redis';

beforeEach(() => {
  handlers.clear();
});

afterEach(async () => {
  await closeSharedRedis();
});

describe('getSharedRedis', () => {
  it('attaches an "error" listener on construction', () => {
    getSharedRedis();
    expect(handlers.has('error')).toBe(true);
  });

  it('the attached listener swallows errors without throwing', () => {
    getSharedRedis();
    const handler = handlers.get('error');
    expect(handler).toBeDefined();
    // The listener routes to the structured logger and returns. It must not
    // throw — an unhandled throw in an EventEmitter listener crashes the
    // process (Node's default behaviour for unhandled 'error' events).
    expect(() => handler!(new Error('ECONNRESET'))).not.toThrow();
  });

  it('returns the same singleton across multiple calls (one listener)', () => {
    const a = getSharedRedis();
    const b = getSharedRedis();
    expect(a).toBe(b);
    expect(handlers.size).toBe(1);
  });
});
