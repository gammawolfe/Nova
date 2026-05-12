// packages/shared/test/load-nova-key.test.ts
//
// Tests that loadNovaPrivateKey accepts both the canonical PKCS8 PEM
// format AND the legacy libsodium 64-byte base64 format, and that the
// two paths produce equivalent KeyObjects.
//
// This is the protected behaviour invariant for the format migration:
// existing installs (legacy format on disk) keep working unchanged;
// new installs get PEM; both produce keys that sign identically.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// KEY_ROOT in @nova/shared/src/tenant is computed at module-load time
// from NOVA_KEY_DIR (with a DATA_ROOT fallback). vi.hoisted runs before
// any import, so setting the env var here pins the key path for the
// life of this test file.
const { keyDir } = vi.hoisted(() => {
  const fsm = require('fs');
  const osm = require('os');
  const pathm = require('path');
  const dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'nova-key-test-'));
  process.env.NOVA_KEY_DIR = dir;
  return { keyDir: dir as string };
});

import { loadNovaPrivateKey } from '../src/invites';

function generateEd25519(): { pem: string; legacyBase64: string; rawPub: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;

  // Raw 32-byte public key (SPKI prefix is 12 fixed bytes).
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = Buffer.from(spkiDer.subarray(12, 44));

  // Raw 32-byte private seed from the PKCS8 DER: last 32 bytes for Ed25519.
  const pkcs8Der = privateKey.export({ format: 'der', type: 'pkcs8' });
  const seed = pkcs8Der.subarray(pkcs8Der.length - 32);

  // libsodium "secretKey" = 32-byte seed || 32-byte pubkey.
  const legacy = Buffer.concat([seed, rawPub]);
  return { pem, legacyBase64: legacy.toString('base64'), rawPub };
}

const keyFile = () => path.join(keyDir, 'nova.private.pem');

beforeEach(() => {
  try { fs.unlinkSync(keyFile()); } catch { /* ignore */ }
});

afterEach(() => {
  try { fs.unlinkSync(keyFile()); } catch { /* ignore */ }
});

afterAll(async () => {
  await fsp.rm(keyDir, { recursive: true, force: true });
});

function writeKeyFile(content: string): void {
  fs.writeFileSync(keyFile(), content, 'utf8');
}

describe('loadNovaPrivateKey', () => {
  it('loads a PKCS8 PEM file (canonical format)', async () => {
    const { pem } = generateEd25519();
    writeKeyFile(pem);

    const key = await loadNovaPrivateKey();
    expect(key.type).toBe('private');
    expect(key.asymmetricKeyType).toBe('ed25519');
  });

  it('loads a legacy libsodium 64-byte base64 file', async () => {
    const { legacyBase64 } = generateEd25519();
    writeKeyFile(legacyBase64);

    const key = await loadNovaPrivateKey();
    expect(key.type).toBe('private');
    expect(key.asymmetricKeyType).toBe('ed25519');
  });

  it('produces equivalent KeyObjects from PEM and legacy formats of the same key', async () => {
    const { pem, legacyBase64, rawPub } = generateEd25519();

    writeKeyFile(pem);
    const fromPem = await loadNovaPrivateKey();
    const pemPub = crypto.createPublicKey(fromPem)
      .export({ format: 'der', type: 'spki' });

    writeKeyFile(legacyBase64);
    const fromLegacy = await loadNovaPrivateKey();
    const legacyPub = crypto.createPublicKey(fromLegacy)
      .export({ format: 'der', type: 'spki' });

    // Same identity from both formats.
    expect(legacyPub.equals(pemPub)).toBe(true);
    expect(Buffer.from(pemPub.subarray(12, 44)).equals(rawPub)).toBe(true);

    // Both can sign and the signatures verify against the same public key —
    // proves the private scalar matches across both load paths.
    const message = Buffer.from('test-payload-bytes');
    const sigPem = crypto.sign(null, message, fromPem);
    const sigLegacy = crypto.sign(null, message, fromLegacy);
    const pubKey = crypto.createPublicKey(fromPem);
    expect(crypto.verify(null, message, pubKey, sigPem)).toBe(true);
    expect(crypto.verify(null, message, pubKey, sigLegacy)).toBe(true);
  });

  it('rejects a file whose base64 decodes to the wrong length', async () => {
    writeKeyFile(crypto.randomBytes(32).toString('base64'));
    await expect(loadNovaPrivateKey()).rejects.toThrow(/unexpected length/);
  });

  it('rejects a missing key file with a clear error pointing at generate-keys', async () => {
    // No write — directory is empty.
    await expect(loadNovaPrivateKey()).rejects.toThrow(/run scripts\/generate-keys/);
  });
});
