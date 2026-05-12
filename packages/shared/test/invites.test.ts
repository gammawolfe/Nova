// packages/shared/test/invites.test.ts
//
// Tests for the shared invite-JWT parser. Covers the structural / claim /
// expiry path that both `verifyInvite` (server-side) and
// `decodeInvitePayload` (client-side) now share via
// `parseInviteJwtPayload`. We don't test signature verification here —
// that's a separate concern, exercised in the existing register-flow
// acceptance tests.

import { describe, it, expect } from 'vitest';
import { parseInviteJwtPayload } from '../src/invites';
import { decodeInvitePayload } from '../src/tenant-config';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // Signature segment can be anything since we're testing the parser only.
  return `${header}.${body}.sig`;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST   = Math.floor(Date.now() / 1000) - 3600;

describe('parseInviteJwtPayload', () => {
  it('parses a well-formed token and exposes the JWT parts', () => {
    const token = makeJwt({ typ: 'invite', tenantId: 't1', jti: 'j1', exp: FUTURE, agentIdHint: 'a1' });
    const parsed = parseInviteJwtPayload(token);
    expect(parsed.tenantId).toBe('t1');
    expect(parsed.jti).toBe('j1');
    expect(parsed.exp).toBe(FUTURE);
    expect(parsed.agentIdHint).toBe('a1');
    expect(parsed.expired).toBeUndefined();
    expect(parsed.parts.headerB64.length).toBeGreaterThan(0);
    expect(parsed.parts.payloadB64.length).toBeGreaterThan(0);
    expect(parsed.parts.signatureB64).toBe('sig');
  });

  it('strips whitespace from terminal-line-wrapped tokens', () => {
    const token = makeJwt({ typ: 'invite', tenantId: 't1', jti: 'j1', exp: FUTURE });
    // Insert newlines mid-token — terminal line-wrapping does this.
    const wrapped = token.slice(0, 20) + '\n' + token.slice(20, 40) + '\r\n' + token.slice(40);
    const parsed = parseInviteJwtPayload(wrapped);
    expect(parsed.tenantId).toBe('t1');
  });

  it('rejects a token that does not split into 3 parts', () => {
    expect(() => parseInviteJwtPayload('not.a.jwt.with-extra')).toThrow(/Malformed/);
    expect(() => parseInviteJwtPayload('twoparts.only')).toThrow(/Malformed/);
  });

  it('rejects a token whose payload is not valid JSON', () => {
    const header = Buffer.from('{}').toString('base64url');
    const body = Buffer.from('{not-json').toString('base64url');
    const token = `${header}.${body}.sig`;
    expect(() => parseInviteJwtPayload(token)).toThrow(/Invite payload malformed/);
  });

  it('rejects a token with the wrong typ', () => {
    const token = makeJwt({ typ: 'access', tenantId: 't1', jti: 'j1', exp: FUTURE });
    expect(() => parseInviteJwtPayload(token)).toThrow(/Not an invite token/);
  });

  it('rejects a token missing required claims', () => {
    const noTenant = makeJwt({ typ: 'invite', jti: 'j1', exp: FUTURE });
    expect(() => parseInviteJwtPayload(noTenant)).toThrow(/missing required claims/);
    const noJti = makeJwt({ typ: 'invite', tenantId: 't1', exp: FUTURE });
    expect(() => parseInviteJwtPayload(noJti)).toThrow(/missing required claims/);
    const noExp = makeJwt({ typ: 'invite', tenantId: 't1', jti: 'j1' });
    expect(() => parseInviteJwtPayload(noExp)).toThrow(/missing required claims/);
    const nonNumericExp = makeJwt({ typ: 'invite', tenantId: 't1', jti: 'j1', exp: '1' });
    expect(() => parseInviteJwtPayload(nonNumericExp)).toThrow(/missing required claims/);
  });

  it('rejects an expired token by default', () => {
    const token = makeJwt({ typ: 'invite', tenantId: 't1', jti: 'j1', exp: PAST });
    expect(() => parseInviteJwtPayload(token)).toThrow(/expired/);
  });

  it('honours allowExpired: returns payload with expired flag', () => {
    const token = makeJwt({ typ: 'invite', tenantId: 't1', jti: 'j1', exp: PAST });
    const parsed = parseInviteJwtPayload(token, { allowExpired: true });
    expect(parsed.tenantId).toBe('t1');
    expect(parsed.expired).toBe(true);
  });
});

describe('decodeInvitePayload (tenant-config thin wrapper)', () => {
  it('returns the parsed payload without the `parts` helper', () => {
    const token = makeJwt({ typ: 'invite', tenantId: 't1', jti: 'j1', exp: FUTURE, agentIdHint: 'a1' });
    const result = decodeInvitePayload(token);
    expect(result.tenantId).toBe('t1');
    expect(result.agentIdHint).toBe('a1');
    expect((result as any).parts).toBeUndefined();
    expect(result.expired).toBeUndefined();
  });

  it('matches parseInviteJwtPayload behaviour on rejection cases', () => {
    expect(() => decodeInvitePayload('bad')).toThrow(/Malformed/);
    expect(() => decodeInvitePayload(
      makeJwt({ typ: 'invite', tenantId: 't1', jti: 'j1', exp: PAST }),
    )).toThrow(/expired/);
    expect(() => decodeInvitePayload(
      makeJwt({ typ: 'invite', tenantId: 't1', jti: 'j1', exp: PAST }),
      { allowExpired: true },
    )).not.toThrow();
  });
});
