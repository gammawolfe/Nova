import { describe, it, expect, afterAll, vi } from 'vitest';
import fsp from 'fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Pin DATA_ROOT to a temp dir BEFORE any module that reads
// process.env.DATA_ROOT at import time (tenant.ts in particular). vi.hoisted
// runs ahead of all imports, so tenant.ts sees this value when it computes
// its `DATA_ROOT` constant.
const { dataRoot } = vi.hoisted(() => {
  const fsm = require('fs');
  const osm = require('os');
  const pathm = require('path');
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'gate-ucan-test-'));
  process.env.DATA_ROOT = dir;
  return { dataRoot: dir as string };
});

// Suppress expected warn logs from negative cases (forged signature,
// revocation I/O failure).
vi.mock('@nova/shared/src/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

import crypto from 'crypto';
import { generateIdentity } from '@nova/shared/src/identity';
import { buildUcanJwt, computeCid, type UcanCapability, type UcanPayload } from '@nova/shared/src/ucan';
import { verifyUCAN, extractIssuerDid } from '../src/ucan-verifier';

const ctx = { tenantId: 't1', agentId: 'a1' };
const SCOPE = 'nova:t1:a1:skill:chat';

// Canonical revocation directory — matches what admin-api writes to and the
// gate-service reads from. UCAN CIDs are sha256, so this is cross-tenant.
const revokedDir = path.join(dataRoot, 'ucans', 'revoked');

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

const nova: Identity = generateIdentity('nova');
const sender: Identity = generateIdentity('sender');

afterAll(async () => {
  await fsp.rm(dataRoot, { recursive: true, force: true });
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
    const grant = mintGrant({ nova, sender: otherSender });
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

  describe('revocation', () => {
    // Each test writes its own tombstone and tears it down, so the canonical
    // dir is reused across the suite without state bleed.
    function writeTombstone(cid: string): void {
      fs.mkdirSync(revokedDir, { recursive: true });
      fs.writeFileSync(path.join(revokedDir, `${cid}.json`), '{}');
    }
    function clearTombstone(cid: string): void {
      try { fs.unlinkSync(path.join(revokedDir, `${cid}.json`)); } catch { /* ignore */ }
    }

    it('reads from the canonical cross-tenant path used by admin-api', async () => {
      const grant = mintGrant({ nova, sender });
      const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
      const cid = computeCid(invocation);
      writeTombstone(cid);
      try {
        const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
        expect(r.valid).toBe(false);
        expect(r.reason).toBe('ucan_revoked');
      } finally {
        clearTombstone(cid);
      }
    });

    it('rejects when the grant CID has been revoked (cascades to invocation)', async () => {
      const grant = mintGrant({ nova, sender });
      const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
      const grantCid = computeCid(grant);
      writeTombstone(grantCid);
      try {
        const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
        expect(r.valid).toBe(false);
        expect(r.reason).toBe('ucan_revoked');
      } finally {
        clearTombstone(grantCid);
      }
    });

    it('fails closed when the revocation directory is unreadable (not silent-pass)', async () => {
      // Create the dir as a regular file to force EISDIR / non-ENOENT on access
      // when the verifier tries to look up <cid>.json under it. Using mode 0
      // would be the obvious choice but it doesn't reliably trigger EACCES
      // when the test runs as root (which is the case in this sandbox).
      const blockedRoot = path.join(dataRoot, 'ucans', 'revoked-blocked-' + Date.now());
      fs.mkdirSync(path.dirname(blockedRoot), { recursive: true });
      fs.writeFileSync(blockedRoot, 'not-a-directory');
      try {
        // Temporarily redirect the verifier at the broken path by renaming.
        const realPath = path.join(dataRoot, 'ucans', 'revoked');
        const stash = realPath + '.stash';
        const hadReal = fs.existsSync(realPath);
        if (hadReal) fs.renameSync(realPath, stash);
        try {
          fs.renameSync(blockedRoot, realPath);
          const grant = mintGrant({ nova, sender });
          const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
          const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
          expect(r.valid).toBe(false);
          expect(r.reason).toBe('revocation_check_failed');
        } finally {
          // Restore the real (or empty) revoked dir
          try { fs.unlinkSync(realPath); } catch { /* ignore */ }
          if (hadReal) fs.renameSync(stash, realPath);
        }
      } finally {
        try { fs.unlinkSync(blockedRoot); } catch { /* ignore */ }
      }
    });
  });
});
