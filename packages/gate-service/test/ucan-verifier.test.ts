import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
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

/**
 * Mint a generic UCAN link with arbitrary issuer + audience + proofs. Used for
 * multi-link chain tests (federation, sub-delegation) where the per-step
 * helpers above (mintGrant, mintInvocation) are too constrained.
 */
function mintLink(opts: {
  signer: Identity;
  iss: string;
  aud: string;
  att?: UcanCapability[];
  exp?: number;
  prf?: string[];
}): string {
  const payload: UcanPayload = {
    iss: opts.iss,
    aud: opts.aud,
    exp: opts.exp ?? nowSec() + 3600,
    nbf: nowSec(),
    att: opts.att ?? [{ with: 'nova:t1:*', can: 'invoke' }],
    prf: opts.prf ?? [],
    jti: crypto.randomUUID(),
  };
  return buildUcanJwt(payload, crypto.createPrivateKey(opts.signer.privateKeyPem));
}

/** Write the trusted-issuers allowlist used by federation chains. */
function writeTrustedIssuers(dids: string[]): void {
  const dir = path.join(dataRoot, 'keys');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trusted-issuers.json'), JSON.stringify({ trusted: dids }));
}
function clearTrustedIssuers(): void {
  try { fs.unlinkSync(path.join(dataRoot, 'keys', 'trusted-issuers.json')); } catch { /* ignore */ }
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
      chainLength: 2,
    });
    // Single-link (non-federation) chain: peerDid is intentionally omitted —
    // there's no peer Nova involved, so attributing a request to one would
    // be misleading.
    expect(r.peerDid).toBeUndefined();
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

  it('rejects when the chain has no Nova-rooted link', async () => {
    // prf[0] is a self-signed grant from a fake root that never reaches Nova.
    const fakeRoot = generateIdentity('fake-root');
    const fakeGrant = mintGrant({ nova: fakeRoot, sender });
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: fakeGrant });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('chain_no_root');
    expect(r.chainDepth).toBe(1);
  });

  it('rejects when a link audience does not match the previous link issuer', async () => {
    const otherSender = generateIdentity('other-sender');
    const grant = mintGrant({ nova, sender: otherSender });
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('chain_audience_mismatch');
    expect(r.chainDepth).toBe(1);
  });

  it('rejects when a link is expired', async () => {
    const grant = mintGrant({ nova, sender, exp: nowSec() - 1 });
    const invocation = mintInvocation({ sender, novaDid: nova.did, grantJwt: grant });
    const r = await verifyUCAN(invocation, ctx, nova.did, SCOPE);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('chain_link_expired');
    expect(r.chainDepth).toBe(1);
  });

  it('rejects when a link widens the chain capability', async () => {
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
    expect(r.reason).toBe('chain_capability_widened');
    expect(r.chainDepth).toBe(1);
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

  describe('multi-link chains (federation)', () => {
    // Federation chain shape (length 3):
    //
    //   outer       sender → novaA          (signed by sender)
    //     prf[0] = peerGrant                (Nova B → sender — signed by novaB)
    //       prf[0] = federationGrant        (Nova A → Nova B — signed by novaA)
    //         prf[] = []                    (root)
    //
    // The receiving Nova ("novaA") walks back to its own signature. The
    // operator must list novaB in trusted-issuers.json (defense-in-depth).
    const novaA = nova; // alias for clarity
    const novaB = generateIdentity('novaB');
    const peerSender = generateIdentity('peer-sender');
    const FEDERATION_SCOPE: UcanCapability[] = [{ with: 'nova:t1:*', can: 'invoke' }];

    afterEach(() => { clearTrustedIssuers(); });

    function buildFederationChain(opts?: {
      peerGrantAud?: string;
      peerGrantAtt?: UcanCapability[];
      federationGrantAtt?: UcanCapability[];
      federationGrantIss?: string;
      invocationAtt?: UcanCapability[];
      peerGrantExp?: number;
      federationGrantExp?: number;
    }) {
      const federationGrant = mintLink({
        signer: novaA,
        iss: opts?.federationGrantIss ?? novaA.did,
        aud: novaB.did,
        att: opts?.federationGrantAtt ?? FEDERATION_SCOPE,
        exp: opts?.federationGrantExp,
        prf: [],
      });
      const peerGrant = mintLink({
        signer: novaB,
        iss: novaB.did,
        aud: opts?.peerGrantAud ?? peerSender.did,
        att: opts?.peerGrantAtt ?? FEDERATION_SCOPE,
        exp: opts?.peerGrantExp,
        prf: [federationGrant],
      });
      const invocation = mintLink({
        signer: peerSender,
        iss: peerSender.did,
        aud: novaA.did,
        att: opts?.invocationAtt ?? [{ with: SCOPE, can: 'invoke' }],
        exp: nowSec() + 300,
        prf: [peerGrant],
      });
      return { federationGrant, peerGrant, invocation };
    }

    it('accepts a 3-link federation chain when the peer is trusted', async () => {
      writeTrustedIssuers([novaB.did]);
      const { invocation, peerGrant } = buildFederationChain();
      const r = await verifyUCAN(invocation, ctx, novaA.did, SCOPE);
      expect(r).toMatchObject({
        valid: true,
        issuerDid: peerSender.did,
        grantCid: computeCid(peerGrant),
        chainLength: 3,
        peerDid: novaB.did, // chain root's aud — the peer Nova we federated with
      });
    });

    it('rejects a federation chain when the peer Nova is not in trusted-issuers', async () => {
      writeTrustedIssuers(['did:web:nova.other.example']); // novaB not listed
      const { invocation } = buildFederationChain();
      const r = await verifyUCAN(invocation, ctx, novaA.did, SCOPE);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('chain_peer_untrusted');
      expect(r.chainDepth).toBe(2);
    });

    it('rejects a federation chain when trusted-issuers.json is missing', async () => {
      // No file written — loadTrustedIssuers returns empty set.
      const { invocation } = buildFederationChain();
      const r = await verifyUCAN(invocation, ctx, novaA.did, SCOPE);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('chain_peer_untrusted');
    });

    it('rejects when an intermediate (depth 2) link widens the chain scope', async () => {
      // Outer narrow → peerGrant broader-but-still-includes-outer → federation
      // grant narrower than peerGrant. The widening edge is peerGrant→federation
      // (depth 2), not outer→peerGrant (depth 1).
      writeTrustedIssuers([novaB.did]);
      const { invocation } = buildFederationChain({
        peerGrantAtt: [{ with: 'nova:t1:*', can: 'invoke' }],
        federationGrantAtt: [{ with: 'nova:t1:agent-b:*', can: 'invoke' }],
      });
      const r = await verifyUCAN(invocation, ctx, novaA.did, SCOPE);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('chain_capability_widened');
      expect(r.chainDepth).toBe(2);
    });

    it('rejects when audience linkage breaks at depth 2', async () => {
      writeTrustedIssuers([novaB.did]);
      const fakeNovaB = generateIdentity('fake-novaB');
      const federationGrant = mintLink({
        signer: novaA,
        iss: novaA.did,
        aud: fakeNovaB.did, // points at a different peer than the one signing the peer grant
        att: FEDERATION_SCOPE,
        prf: [],
      });
      const peerGrant = mintLink({
        signer: novaB,
        iss: novaB.did, // doesn't match fakeNovaB
        aud: peerSender.did,
        att: FEDERATION_SCOPE,
        prf: [federationGrant],
      });
      const invocation = mintLink({
        signer: peerSender,
        iss: peerSender.did,
        aud: novaA.did,
        att: [{ with: SCOPE, can: 'invoke' }],
        exp: nowSec() + 300,
        prf: [peerGrant],
      });
      const r = await verifyUCAN(invocation, ctx, novaA.did, SCOPE);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('chain_audience_mismatch');
      expect(r.chainDepth).toBe(2);
    });

    it('rejects when an intermediate link is signed by the wrong key', async () => {
      writeTrustedIssuers([novaB.did]);
      const impostor = generateIdentity('impostor');
      // peerGrant claims iss=novaB but is signed by impostor — signature
      // validation fails when walkUcanChain descends.
      const federationGrant = mintLink({
        signer: novaA,
        iss: novaA.did,
        aud: novaB.did,
        att: FEDERATION_SCOPE,
        prf: [],
      });
      const forgedPeerGrant = mintLink({
        signer: impostor,
        iss: novaB.did, // claimed iss
        aud: peerSender.did,
        att: FEDERATION_SCOPE,
        prf: [federationGrant],
      });
      const invocation = mintLink({
        signer: peerSender,
        iss: peerSender.did,
        aud: novaA.did,
        att: [{ with: SCOPE, can: 'invoke' }],
        exp: nowSec() + 300,
        prf: [forgedPeerGrant],
      });
      const r = await verifyUCAN(invocation, ctx, novaA.did, SCOPE);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('chain_link_invalid_signature');
      expect(r.chainDepth).toBe(1);
    });

    it('rejects when the deepest link claims iss=novaDid but still carries proofs (downgrade attempt)', async () => {
      writeTrustedIssuers([novaB.did]);
      // An attacker constructs a "root-like" link whose iss is novaDid but
      // which itself has a non-empty prf, attempting to graft a longer
      // chain onto our trust anchor. Strict-chain rejects this.
      const buriedProof = mintLink({
        signer: novaA, iss: novaA.did, aud: novaB.did, att: FEDERATION_SCOPE, prf: [],
      });
      const fakeRoot = mintLink({
        signer: novaA,
        iss: novaA.did,
        aud: peerSender.did,
        att: FEDERATION_SCOPE,
        prf: [buriedProof], // a real root has prf:[]
      });
      const invocation = mintLink({
        signer: peerSender,
        iss: peerSender.did,
        aud: novaA.did,
        att: [{ with: SCOPE, can: 'invoke' }],
        exp: nowSec() + 300,
        prf: [fakeRoot],
      });
      const r = await verifyUCAN(invocation, ctx, novaA.did, SCOPE);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('chain_root_has_proofs');
    });

    it('rejects when a link carries more than one proof (non-strict chain)', async () => {
      writeTrustedIssuers([novaB.did]);
      const federationGrant = mintLink({
        signer: novaA, iss: novaA.did, aud: novaB.did, att: FEDERATION_SCOPE, prf: [],
      });
      const extraProof = mintLink({
        signer: novaA, iss: novaA.did, aud: novaB.did, att: FEDERATION_SCOPE, prf: [],
      });
      const peerGrantPayload: UcanPayload = {
        iss: novaB.did,
        aud: peerSender.did,
        exp: nowSec() + 3600,
        nbf: nowSec(),
        att: FEDERATION_SCOPE,
        prf: [federationGrant, extraProof], // two proofs — rejected by strict-chain
        jti: crypto.randomUUID(),
      };
      const peerGrant = buildUcanJwt(peerGrantPayload, crypto.createPrivateKey(novaB.privateKeyPem));
      const invocation = mintLink({
        signer: peerSender,
        iss: peerSender.did,
        aud: novaA.did,
        att: [{ with: SCOPE, can: 'invoke' }],
        exp: nowSec() + 300,
        prf: [peerGrant],
      });
      const r = await verifyUCAN(invocation, ctx, novaA.did, SCOPE);
      expect(r.valid).toBe(false);
      expect(r.reason).toBe('chain_link_too_many_proofs');
    });
  });
});
