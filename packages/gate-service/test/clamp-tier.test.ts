// packages/gate-service/test/clamp-tier.test.ts
//
// Direct unit tests for the trust-tier clamp. The clamp guards against
// malformed trust-registry records elevating a sender's tier past the
// {0,1,2,3} range. A hand-edited bad file shouldn't widen authority.

import { describe, it, expect } from 'vitest';
import { clampTier } from '../src/pipeline';

describe('clampTier', () => {
  it('passes through valid integer tiers', () => {
    expect(clampTier(0)).toBe(0);
    expect(clampTier(1)).toBe(1);
    expect(clampTier(2)).toBe(2);
    expect(clampTier(3)).toBe(3);
  });

  it('clamps integer tiers above 3 to 0 (fail-closed)', () => {
    expect(clampTier(4)).toBe(0);
    expect(clampTier(99)).toBe(0);
    expect(clampTier(Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it('clamps negative tiers to 0', () => {
    expect(clampTier(-1)).toBe(0);
    expect(clampTier(-3)).toBe(0);
    expect(clampTier(Number.MIN_SAFE_INTEGER)).toBe(0);
  });

  it('rejects non-integer numbers (fractions, NaN, Infinity)', () => {
    expect(clampTier(1.5)).toBe(0);
    expect(clampTier(0.99)).toBe(0);
    expect(clampTier(Number.NaN)).toBe(0);
    expect(clampTier(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampTier(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('rejects non-number types entirely', () => {
    expect(clampTier('2')).toBe(0);
    expect(clampTier(null)).toBe(0);
    expect(clampTier(undefined)).toBe(0);
    expect(clampTier({})).toBe(0);
    expect(clampTier([])).toBe(0);
    expect(clampTier(true)).toBe(0);
  });
});
