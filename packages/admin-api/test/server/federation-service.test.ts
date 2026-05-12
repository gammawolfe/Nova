// packages/admin-api/test/server/federation-service.test.ts
//
// Unit tests for the federation-grant pieces of ucan-service:
//   - issueFederationGrant: signs a UCAN whose chain a real Nova
//     gate verifier accepts as a root (single-link "chain") when the
//     peer is in trusted-issuers.
//   - listFederationGrants: kind='federation' filter, ignores tenants.
//
// Tests run against a temp DATA_ROOT with a generated Nova identity, so
// they exercise the real Ed25519 signing path end-to-end. The verifier
// import is real — federation grants are validated by walking the chain
// produced by Phase 2B-A.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { dataRoot } = vi.hoisted(() => {
  const fsm = require('fs');
  const osm = require('os');
  const pathm = require('path');
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'fed-service-test-'));
  process.env.DATA_ROOT = dir;
  return { dataRoot: dir as string };
});

vi.mock('@nova/shared/src/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

import { generateIdentity } from '@nova/shared/src/identity';
import { parseUcanJwt, walkUcanChain } from '@nova/shared/src/ucan';
import { novaUcansValidate } from '@nova/shared/src/ucan-plugins';
import * as ucanService from '../../src/services/ucan-service';

const novaIdentity = generateIdentity('nova');

beforeAll(async () => {
  const keysDir = path.join(dataRoot, 'keys');
  await fsp.mkdir(keysDir, { recursive: true });
  await fsp.writeFile(path.join(keysDir, 'nova.private.pem'), novaIdentity.privateKeyPem, { mode: 0o600 });
  await fsp.writeFile(path.join(keysDir, 'nova.did'), novaIdentity.did);
});

afterAll(async () => {
  await fsp.rm(dataRoot, { recursive: true, force: true });
});

describe('issueFederationGrant', () => {
  it('mints a UCAN with iss=novaDid, aud=peerDid, empty prf', async () => {
    const peer = generateIdentity('peer');
    const result = await ucanService.issueFederationGrant({
      peerDid: peer.did,
      scope: ['nova:public:*'],
      expiryDays: 7,
    });
    expect(result.peerDid).toBe(peer.did);
    expect(result.cid).toHaveLength(32);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const parsed = parseUcanJwt(result.jwt);
    expect(parsed.payload.iss).toBe(novaIdentity.did);
    expect(parsed.payload.aud).toBe(peer.did);
    expect(parsed.payload.prf).toEqual([]);
    expect(parsed.payload.att).toEqual([{ with: 'nova:public:*', can: 'invoke' }]);
  });

  it('persists metadata under data/ucans/issued/ with kind=federation', async () => {
    const peer = generateIdentity('peer-meta');
    const result = await ucanService.issueFederationGrant({
      peerDid: peer.did,
      scope: ['nova:public:*'],
      expiryDays: 30,
      note: 'partner Nova rollout',
    });
    const metaPath = path.join(dataRoot, 'ucans', 'issued', `${result.cid}.json`);
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    expect(meta.kind).toBe('federation');
    expect(meta.issuedTo).toBe(peer.did);
    expect(meta.tenantId).toBeUndefined();
    expect(meta.note).toBe('partner Nova rollout');
    expect(meta.revoked).toBe(false);
  });

  it('signs with the Nova key — signature verifies via the real chain walker', async () => {
    const peer = generateIdentity('peer-verify');
    const result = await ucanService.issueFederationGrant({
      peerDid: peer.did,
      scope: ['nova:public:*'],
      expiryDays: 7,
    });
    // The federation grant on its own is a single-link "chain" (just the
    // root). walkUcanChain treats outer === root as depth 0.
    const parsed = parseUcanJwt(result.jwt);
    const chain = await walkUcanChain(
      { jwt: result.jwt, payload: parsed.payload },
      novaIdentity.did,
      novaUcansValidate,
    );
    expect(chain.ok).toBe(true);
    if (chain.ok) {
      expect(chain.depth).toBe(0);
      expect(chain.root.payload.aud).toBe(peer.did);
    }
  });

  it('rejects a peerDid equal to this Nova\'s DID', async () => {
    await expect(ucanService.issueFederationGrant({
      peerDid: novaIdentity.did,
      scope: ['nova:public:*'],
      expiryDays: 7,
    })).rejects.toThrow(/peerDid equals this Nova/);
  });

  it('accepts multiple scope entries and renders each as an att capability', async () => {
    const peer = generateIdentity('peer-multi');
    const result = await ucanService.issueFederationGrant({
      peerDid: peer.did,
      scope: ['nova:public:calendar:*', 'nova:public:notes:*'],
      expiryDays: 7,
    });
    const parsed = parseUcanJwt(result.jwt);
    expect(parsed.payload.att).toEqual([
      { with: 'nova:public:calendar:*', can: 'invoke' },
      { with: 'nova:public:notes:*', can: 'invoke' },
    ]);
  });
});

describe('listFederationGrants', () => {
  it('returns only kind=federation records, with no tenant filtering', async () => {
    // Mix federation grants with a regular tenant grant; verify only the
    // federation entries surface.
    const peerA = generateIdentity('peer-list-a');
    const peerB = generateIdentity('peer-list-b');
    const a = await ucanService.issueFederationGrant({
      peerDid: peerA.did, scope: ['nova:public:*'], expiryDays: 7,
    });
    const b = await ucanService.issueFederationGrant({
      peerDid: peerB.did, scope: ['nova:public:*'], expiryDays: 14,
    });
    const subject = generateIdentity('subject-list');
    await ucanService.issueApprovalGrant('tenant-list', {
      subjectDid: subject.did, capabilities: ['nova:tenant-list:*'], expiryDays: 7,
    });

    const list = await ucanService.listFederationGrants();
    const cids = list.map(g => g.cid).sort();
    expect(cids).toContain(a.cid);
    expect(cids).toContain(b.cid);
    expect(list.every(g => g.kind === 'federation')).toBe(true);
    expect(list.every(g => g.tenantId === undefined)).toBe(true);
  });

  it('returns an empty array when the issued directory is missing', async () => {
    // Use a fresh temp data root via a service call that won't auto-create
    // the dir. Just delete and re-test from a different angle: rename to
    // simulate absence, then restore.
    const issuedDir = path.join(dataRoot, 'ucans', 'issued');
    const stash = issuedDir + '.stash';
    fs.renameSync(issuedDir, stash);
    try {
      const list = await ucanService.listFederationGrants();
      expect(list).toEqual([]);
    } finally {
      fs.renameSync(stash, issuedDir);
    }
  });
});
