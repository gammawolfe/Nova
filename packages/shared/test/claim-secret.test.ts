// packages/shared/test/claim-secret.test.ts
//
// Unit tests for the H17 claim-secret helpers.

import { describe, it, expect } from 'vitest';
import {
  generateClaimSecret,
  commitmentOf,
  commitmentEquals,
  isValidCommitment,
  COMMITMENT_HEX_LEN,
  CLAIM_SECRET_HEADER,
  MAX_FAILED_ATTEMPTS,
} from '../src/claim-secret';

describe('claim-secret', () => {
  describe('generateClaimSecret', () => {
    it('returns a base64url secret and a 64-hex commitment', () => {
      const { secret, commitment } = generateClaimSecret();
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThan(0);
      expect(/^[A-Za-z0-9_-]+$/.test(secret)).toBe(true);   // base64url alphabet
      expect(commitment).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces unique secrets across calls', () => {
      const a = generateClaimSecret();
      const b = generateClaimSecret();
      expect(a.secret).not.toBe(b.secret);
      expect(a.commitment).not.toBe(b.commitment);
    });

    it('commitment is consistent: commitmentOf(secret) === commitment', () => {
      const { secret, commitment } = generateClaimSecret();
      expect(commitmentOf(secret)).toBe(commitment);
    });
  });

  describe('commitmentOf', () => {
    it('is deterministic — same input produces same hash', () => {
      const c1 = commitmentOf('test-secret-value');
      const c2 = commitmentOf('test-secret-value');
      expect(c1).toBe(c2);
    });

    it('is sensitive to input changes — single-char delta produces different hash', () => {
      const c1 = commitmentOf('test-secret-value');
      const c2 = commitmentOf('test-secret-valuf');
      expect(c1).not.toBe(c2);
    });

    it('handles empty string', () => {
      const c = commitmentOf('');
      expect(c).toMatch(/^[a-f0-9]{64}$/);
      // SHA-256 of empty string is a known value
      expect(c).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  describe('commitmentEquals', () => {
    it('returns true for identical commitments', () => {
      const { commitment } = generateClaimSecret();
      expect(commitmentEquals(commitment, commitment)).toBe(true);
    });

    it('returns false for different commitments', () => {
      const a = generateClaimSecret();
      const b = generateClaimSecret();
      expect(commitmentEquals(a.commitment, b.commitment)).toBe(false);
    });

    it('returns false for length-mismatched inputs (no comparison performed)', () => {
      expect(commitmentEquals('a'.repeat(64), 'a'.repeat(63))).toBe(false);
      expect(commitmentEquals('a'.repeat(64), 'a'.repeat(65))).toBe(false);
    });

    it('returns false for non-canonical-length inputs', () => {
      expect(commitmentEquals('abc', 'abc')).toBe(false);
      expect(commitmentEquals('a'.repeat(128), 'a'.repeat(128))).toBe(false);
    });

    it('returns false on non-string inputs', () => {
      // @ts-expect-error testing runtime guard
      expect(commitmentEquals(undefined, 'a'.repeat(64))).toBe(false);
      // @ts-expect-error testing runtime guard
      expect(commitmentEquals('a'.repeat(64), null)).toBe(false);
      // @ts-expect-error testing runtime guard
      expect(commitmentEquals(123, 456)).toBe(false);
    });
  });

  describe('isValidCommitment', () => {
    it('accepts valid 64-char lowercase hex', () => {
      const { commitment } = generateClaimSecret();
      expect(isValidCommitment(commitment)).toBe(true);
      expect(isValidCommitment('0123456789abcdef'.repeat(4))).toBe(true);
    });

    it('rejects uppercase hex', () => {
      expect(isValidCommitment('0123456789ABCDEF'.repeat(4))).toBe(false);
    });

    it('rejects wrong length', () => {
      expect(isValidCommitment('a'.repeat(63))).toBe(false);
      expect(isValidCommitment('a'.repeat(65))).toBe(false);
      expect(isValidCommitment('')).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(isValidCommitment('z'.repeat(64))).toBe(false);
      expect(isValidCommitment('g'.repeat(64))).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(isValidCommitment(undefined)).toBe(false);
      expect(isValidCommitment(null)).toBe(false);
      expect(isValidCommitment(12345)).toBe(false);
      expect(isValidCommitment({})).toBe(false);
    });
  });

  describe('exported constants', () => {
    it('header name is the lowercase HTTP convention', () => {
      expect(CLAIM_SECRET_HEADER).toBe('x-claim-secret');
    });

    it('commitment hex length is 64 (SHA-256)', () => {
      expect(COMMITMENT_HEX_LEN).toBe(64);
    });

    it('max failed attempts is small but non-trivial', () => {
      expect(MAX_FAILED_ATTEMPTS).toBeGreaterThanOrEqual(2);
      expect(MAX_FAILED_ATTEMPTS).toBeLessThanOrEqual(10);
    });
  });
});
