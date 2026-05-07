// packages/a2a-server/test/sse-registry.test.ts
//
// Verifies the SSE-cleanup registry that backs the H1 graceful-shutdown drain.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerSseCleanup,
  drainSseStreams,
  liveStreamCount,
} from '../src/sse-registry';

describe('sse-registry', () => {
  beforeEach(() => {
    // Drain anything left from prior tests so each starts clean.
    drainSseStreams();
  });

  it('starts empty', () => {
    expect(liveStreamCount()).toBe(0);
  });

  it('register increments live count', () => {
    registerSseCleanup(() => {});
    expect(liveStreamCount()).toBe(1);
    registerSseCleanup(() => {});
    expect(liveStreamCount()).toBe(2);
  });

  it('unregister callback decrements live count', () => {
    const off = registerSseCleanup(() => {});
    expect(liveStreamCount()).toBe(1);
    off();
    expect(liveStreamCount()).toBe(0);
  });

  it('unregister called twice is idempotent', () => {
    const off = registerSseCleanup(() => {});
    off();
    off();
    expect(liveStreamCount()).toBe(0);
  });

  it('drain invokes every cleanup and clears the registry', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    registerSseCleanup(a);
    registerSseCleanup(b);
    registerSseCleanup(c);

    expect(liveStreamCount()).toBe(3);
    const drained = drainSseStreams();

    expect(drained).toBe(3);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(c).toHaveBeenCalledOnce();
    expect(liveStreamCount()).toBe(0);
  });

  it('drain continues even if a cleanup throws', () => {
    const a = vi.fn();
    const b = vi.fn(() => { throw new Error('boom'); });
    const c = vi.fn();
    registerSseCleanup(a);
    registerSseCleanup(b);
    registerSseCleanup(c);

    expect(() => drainSseStreams()).not.toThrow();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(c).toHaveBeenCalledOnce();
  });

  it('drain returns the count drained even if cleanups remove entries themselves', () => {
    // Real-world case: each cleanup also unregisters itself from the registry.
    // The returned count must reflect what was processed, not what was left.
    const offs: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      const off = registerSseCleanup(() => off());
      offs.push(off);
    }
    expect(liveStreamCount()).toBe(5);
    expect(drainSseStreams()).toBe(5);
    expect(liveStreamCount()).toBe(0);
  });
});
