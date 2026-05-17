import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import bs58 from 'bs58';
import { keyManager } from '../src/key-manager';

const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

function generateEd25519(): { pem: string; legacyBase64: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;

  const jwk = {
    private: privateKey.export({ format: 'jwk' }) as { d?: string },
    public: publicKey.export({ format: 'jwk' }) as { x?: string },
  };
  if (!jwk.private.d || !jwk.public.x) throw new Error('missing Ed25519 JWK coordinates');

  const legacyBase64 = Buffer.concat([
    Buffer.from(jwk.private.d, 'base64url'),
    Buffer.from(jwk.public.x, 'base64url'),
  ]).toString('base64');

  return { pem, legacyBase64 };
}

function didKeyFromLegacyBase64(legacyBase64: string): string {
  const raw = Buffer.from(legacyBase64, 'base64');
  const prefixed = Buffer.concat([ED25519_MULTICODEC_PREFIX, raw.subarray(32, 64)]);
  return `did:key:z${bs58.encode(prefixed)}`;
}

async function withKeyFiles(
  keyContent: string,
  didContent: string | null,
  fn: (privateKeyPath: string, didPath: string) => Promise<void>,
): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-a2a-key-manager-'));
  try {
    const privateKeyPath = path.join(dir, 'nova.private.pem');
    const didPath = path.join(dir, 'nova.did');
    fs.writeFileSync(privateKeyPath, keyContent, { encoding: 'utf8', mode: 0o600 });
    if (didContent) fs.writeFileSync(didPath, didContent, 'utf8');
    await fn(privateKeyPath, didPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe('keyManager', () => {
  it('loads canonical PKCS8 PEM keys and honors nova.did', async () => {
    const { pem } = generateEd25519();
    await withKeyFiles(pem, 'did:web:nova.example.com', async (privateKeyPath, didPath) => {
      await keyManager.initialize(privateKeyPath, didPath);

      expect(keyManager.getDid()).toBe('did:web:nova.example.com');
    });
  });

  it('loads legacy 64-byte base64 keys when no did file is present', async () => {
    const { legacyBase64 } = generateEd25519();
    await withKeyFiles(legacyBase64, null, async (privateKeyPath, didPath) => {
      await keyManager.initialize(privateKeyPath, didPath);

      expect(keyManager.getDid()).toBe(didKeyFromLegacyBase64(legacyBase64));
    });
  });
});
