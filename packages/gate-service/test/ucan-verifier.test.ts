import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// Hold the temp data root so the vi.mock factory can read it lazily.
const state: { dataRoot: string } = { dataRoot: '' };

vi.mock('@nova/shared/src/tenant', async () => {
  const actual = await vi.importActual<typeof import('@nova/shared/src/tenant')>('@nova/shared/src/tenant');
  return {
    ...actual,
    tenantDataPath: (ctx: { tenantId: string; agentId: string }, ...parts: string[]) =>
      path.join(state.dataRoot, 'tenants', ctx.tenantId, 'agents', ctx.agentId, ...parts),
  };
});

// Suppress expected warn logs from the forged-signature negative case.
vi.mock('@nova/shared/src/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

import crypto from 'crypto';
import { generateIdentity } from '@nova/shared/src/identity';
import { buildUcanJwt, computeCid, type UcanCapability, type UcanPayload } from '@nova/shared/src/ucan';
import { verifyUCAN, extractIssuerDid } from '../src/ucan-verifier';

const ctx = { tenantId: 't1', agentId: 'a1' };
const SCOPE = 'nova:t1:a1:skill:chat';

interface Identity {
  did: string;
  privateKeyPem: string;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function mintGrant(opts: {
  nova: Identity;
  sender: Identity;
  att?: UcanCapability[];
  exp?: number;
  iss?: string;
  aud?: string;
}): string {
  const payload: UcanPayload = {
    iss: opts.iss ?? opts.nova.did,
    aud: opts.aud ?? opts.sender.did,
    exp: opts.exp ?? nowSec() + 3600,
    nbf: nowSec(),
    att: opts.att ?? [{ with: 'nova:t1:*', can: 'invoke' }],
    prf: [],
    jti: crypto.randomUUID(),
  };
  return buildUcanJwt(payload, crypto.createPrivateKey(opts.nova.privateKeyPem));
}

function mintInvocation(opts: {
  sender: Identity;
  novaDid: string;
  grantJwt: string;
  att?: UcanCapability[];
  exp?: number;
  aud?: string;
}): string {
  const payload: UcanPayload = {
    iss: opts.sender.did,
    aud: opts.aud ?? opts.novaDid,
    exp: opts.exp ?? nowSec() + 300,
    nbf: nowSec(),
    att: opts.att ?? [{ with: SCOPE, can: 'invoke' }],
    prf: [opts.grantJwt],
    jti: crypto.randomUUID(),
  };
  return buildUcanJwt(payload, crypto.createPrivateKey(opts.sender.privateKeyPem));
}

let nova: Identity;
let sender: Identity;

beforeAll(async () => {
  state.dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gate-ucan-test-'));
  nova = generateIdentity('nova');
  sender = generateIdentity('sender');
});

afterAll(async () => {
  await fsp.rm(state.dataRoot, { recursive: true, force: true });
});

describe('extractIssuerDid', () => {
  it('returns the iss DID from a well-formed UCAN', () => {
    const grant = mintGrant({ nova, sender });
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
    expect(extractIssuerDid(invocation)).toBe(sender.did);
  });

  it('returns null on a malformed JWT', () => {
    expect(extractIssuerDid('not.a.jwt')).toBeNull();
    expect(extractIssuerDid('garbage')).toBeNull();
  });
});

describe('verifyUCAN', () => {
  it('accepts a well-formed delegation chain (happy path)', async () => {
    const grant = mintGrant({ nova, sender });
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r).toMatchObject({
      valid: true,
      issuerDid: sender.did,
      grantCid: computeCid(grant),
    });
  });

  it('rejects a malformed JWT', async () => {
    const r = await verifyUCAN('not.a.jwt', ctx, nova.did, SCOPE);
    expect(r).toEqual({ valid: false, reason: 'ucan_malformed' });
  });

  it('rejects when the outer signature is invalid (wrong key)', async () => {
    const intruder = generateIdentity('intruder');
    const grant = mintGrant({ nova, sender });
    // sender's payload, but signed by an unrelated key
    const payload: UcanPayload = {
      iss: sender.did,
      aud: nova.did,
      exp: nowSec() + 300,
      nbf: nowSec(),
      att: [{ with: SCOPE, can: 'invoke' }],
      prf: [grant],
      jti: crypto.randomUUID(),
    };
    const forged = buildUcanJwt(payload, crypto.createPrivateKey(intruder.privateKeyPem));
    const r = await verifyUCAN(forged, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('ucan_invalid_signature');
  });

  it('rejects an expired invocation', async () => {
    const grant = mintGrant({ nova, sender });
    const invocation = mintInvocation({
      sender,
      novaDid: nova.did,
      grantJwt: grant,
      exp: nowSec() - 1,
    });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('ucan_expired');
  });

  it('rejects when audience is not Nova', async () => {
    const stranger = generateIdentity('stranger');
    const grant = mintGrant({ nova, sender });
    const invocation = mintInvocation({
      sender,
      novaDid: nova.did,
      grantJwt: grant,
      aud: stranger.did,
    });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('ucan_wrong_audience');
  });

  it('rejects when the proof chain is empty', async () => {
    const payload: UcanPayload = {
      iss: sender.did,
      aud: nova.did,
      exp: nowSec() + 300,
      nbf: nowSec(),
      att: [{ with: SCOPE, can: 'invoke' }],
      prf: [],
      jti: crypto.randomUUID(),
    };
    const noProofInvocation = buildUcanJwt(payload, crypto.createPrivateKey(sender.privateKeyPem));
    const r = await verifyUCAN(noProofInvocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('ucan_no_proof');
  });

  it('rejects when the grant is not issued by Nova', async () => {
    const fakeRoot = generateIdentity('fake-root');
    const fakeGrant = mintGrant({ nova: fakeRoot, sender });
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: fakeGrant });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('grant_not_from_nova');
  });

  it('rejects when the grant audience is not the invocation issuer', async () => {
    const otherSender = generateIdentity('other-sender');
    const grant = mintGrant({ nova, sender: otherSender }); // grant aud = other-sender
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('grant_wrong_audience');
  });

  it('rejects when the grant is expired', async () => {
    const grant = mintGrant({ nova, sender, exp: nowSec() - 1 });
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('grant_expired');
  });

  it('rejects when the invocation widens the grant capability', async () => {
    // Grant only covers tenant t1, but invocation tries to invoke t2.
    const narrowGrant = mintGrant({
      nova,
      sender,
      att: [{ with: 'nova:t1:*', can: 'invoke' }],
    });
    const invocation = mintInvocation({
      sender,
      novaDid: nova.did,
      grantJwt: narrowGrant,
      att: [{ with: 'nova:t2:a1:skill:chat', can: 'invoke' }],
    });
    const r = await verifyUCAN(invocation, ctx, nova.did, 'nova:t2:a1:skill:chat');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('grant_does_not_subsume_invocation');
  });

  it("rejects when the invocation does not target the request's destination", async () => {
    const grant = mintGrant({ nova, sender });
    const invocation = mintInvocation({
      sender,
      novaDid: nova.did,
      grantJwt: grant,
      att: [{ with: 'nova:t1:other-agent:skill:chat', can: 'invoke' }],
    });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('ucan_insufficient_capability');
  });

  it('rejects when the invocation CID has been revoked', async () => {
    const grant = mintGrant({ nova, sender });
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
    const cid = computeCid(invocation);
    // The verifier looks under tenants/<tenantId>/agents/<agentId>/../ucans/revoked/
    // which path.join normalizes to tenants/<tenantId>/agents/ucans/revoked/.
    const revokedDir = path.join(state.dataRoot, 'tenants', ctx.tenantId, 'agents', 'ucans', 'revoked');
    await fsp.mkdir(revokedDir, { recursive: true });
    await fsp.writeFile(path.join(revokedDir, `${cid}.json`), '{}');
    try {
      const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('ucan_revoked');
    } finally {
      await fsp.rm(revokedDir, { recursive: true, force: true });
    }
  });

  it('rejects when the grant CID has been revoked (cascades to invocation)', async () => {
    const grant = mintGrant({ nova, sender });
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
    const grantCid = computeCid(grant);
    const revokedDir = path.join(state.dataRoot, 'tenants', ctx.tenantId, 'agents', 'ucans', 'revoked');
    await fsp.mkdir(revokedDir, { recursive: true });
    await fsp.writeFile(path.join(revokedDir, `${grantCid}.json`), '{}');
    try {
      const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('ucan_revoked');
    } finally {
      await fsp.rm(revokedDir, { recursive: true, force: true });
    }
  });
});
