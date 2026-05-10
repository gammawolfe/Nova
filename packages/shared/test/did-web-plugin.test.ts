// packages/shared/test/did-web-plugin.test.ts
//
// Unit tests for the did:web UCAN method plugin. Covers:
//   - self short-circuit (no HTTP fetch, uses provided public key)
//   - HTTP resolution path (via injected fetch)
//   - signature rejection on tamper
//   - alg check
//   - cache TTL behavior
//   - DID document id mismatch defense

import { describe, it, expect, vi } from 'vitest';
import crypto, { generateKeyPairSync } from 'crypto';
import { createDidWebPlugin } from '../src/did-web-plugin';
import { buildDidDocument } from '../src/did-document';

function signEd25519(privateKey: crypto.KeyObject, data: Uint8Array): Uint8Array {
  return Uint8Array.from(crypto.sign(null, data, privateKey));
}

describe('createDidWebPlugin — checkJwtAlg', () => {
  it('accepts EdDSA', () => {
    const plugin = createDidWebPlugin();
    expect(plugin.checkJwtAlg('did:web:nova.example.com', 'EdDSA')).toBe(true);
  });

  it('rejects non-EdDSA algs', () => {
    const plugin = createDidWebPlugin();
    expect(plugin.checkJwtAlg('did:web:nova.example.com', 'RS256')).toBe(false);
    expect(plugin.checkJwtAlg('did:web:nova.example.com', 'ES256')).toBe(false);
    expect(plugin.checkJwtAlg('did:web:nova.example.com', '')).toBe(false);
  });
});

describe('createDidWebPlugin — verifySignature self short-circuit', () => {
  it('verifies valid signatures using the provided self key without fetching', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const fetchSpy = vi.fn().mockRejectedValue(new Error('should not fetch'));
    const plugin = createDidWebPlugin({
      selfDid: 'did:web:nova.family.com',
      selfPublicKey: publicKey,
      fetch: fetchSpy,
    });

    const data = new TextEncoder().encode('hello world');
    const sig = signEd25519(privateKey, data);

    expect(await plugin.verifySignature('did:web:nova.family.com', data, sig)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects forged signatures even on the self path', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const plugin = createDidWebPlugin({
      selfDid: 'did:web:nova.family.com',
      selfPublicKey: publicKey,
    });

    const data = new TextEncoder().encode('hello');
    const sig = signEd25519(privateKey, data);
    const tampered = new TextEncoder().encode('Hello'); // capital H — different bytes

    expect(await plugin.verifySignature('did:web:nova.family.com', tampered, sig)).toBe(false);
  });

  it('throws when selfDid is set but selfPublicKey is missing', async () => {
    const plugin = createDidWebPlugin({ selfDid: 'did:web:nova.family.com' });
    const data = new TextEncoder().encode('hi');
    const sig = new Uint8Array(64); // garbage

    await expect(
      plugin.verifySignature('did:web:nova.family.com', data, sig),
    ).rejects.toThrow(/selfPublicKey missing/);
  });
});

describe('createDidWebPlugin — verifySignature HTTP resolution', () => {
  it('fetches the DID document and verifies a peer Nova signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const peerDid = 'did:web:nova.bookstore.com';
    const peerDoc = buildDidDocument({ did: peerDid, publicKey });
    const fetchSpy = vi.fn().mockResolvedValue(peerDoc);
    const plugin = createDidWebPlugin({ fetch: fetchSpy });

    const data = new TextEncoder().encode('peer-signed payload');
    const sig = signEd25519(privateKey, data);

    expect(await plugin.verifySignature(peerDid, data, sig)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith('https://nova.bookstore.com/.well-known/did.json');
  });

  it('caches the DID document across calls within the TTL', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const peerDid = 'did:web:nova.bookstore.com';
    const peerDoc = buildDidDocument({ did: peerDid, publicKey });
    const fetchSpy = vi.fn().mockResolvedValue(peerDoc);
    const plugin = createDidWebPlugin({ fetch: fetchSpy });

    const data = new TextEncoder().encode('p');
    const sig = signEd25519(privateKey, data);
    await plugin.verifySignature(peerDid, data, sig);
    await plugin.verifySignature(peerDid, data, sig);
    await plugin.verifySignature(peerDid, data, sig);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('refetches when caching is disabled (cacheTtlMs=0)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const peerDid = 'did:web:nova.bookstore.com';
    const peerDoc = buildDidDocument({ did: peerDid, publicKey });
    const fetchSpy = vi.fn().mockResolvedValue(peerDoc);
    const plugin = createDidWebPlugin({ fetch: fetchSpy, cacheTtlMs: 0 });

    const data = new TextEncoder().encode('x');
    const sig = signEd25519(privateKey, data);
    await plugin.verifySignature(peerDid, data, sig);
    await plugin.verifySignature(peerDid, data, sig);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects when the DID document declares a different id than was requested', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const wrongDoc = buildDidDocument({ did: 'did:web:nova.OTHER.com', publicKey });
    const fetchSpy = vi.fn().mockResolvedValue(wrongDoc);
    const plugin = createDidWebPlugin({ fetch: fetchSpy });

    const data = new TextEncoder().encode('x');
    const sig = new Uint8Array(64);

    await expect(
      plugin.verifySignature('did:web:nova.bookstore.com', data, sig),
    ).rejects.toThrow(/id mismatch/);
  });

  it('rejects when the document has no Ed25519 verification method', async () => {
    const fakeDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:nova.bookstore.com',
      verificationMethod: [],
      assertionMethod: [],
      authentication: [],
    };
    const fetchSpy = vi.fn().mockResolvedValue(fakeDoc);
    const plugin = createDidWebPlugin({ fetch: fetchSpy });

    const data = new TextEncoder().encode('x');
    const sig = new Uint8Array(64);

    await expect(
      plugin.verifySignature('did:web:nova.bookstore.com', data, sig),
    ).rejects.toThrow(/no Ed25519VerificationKey2020/);
  });

  it('rejects forged signatures from a peer Nova', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const { privateKey: attackerKey } = generateKeyPairSync('ed25519'); // different keypair
    const peerDid = 'did:web:nova.bookstore.com';
    const peerDoc = buildDidDocument({ did: peerDid, publicKey });
    const fetchSpy = vi.fn().mockResolvedValue(peerDoc);
    const plugin = createDidWebPlugin({ fetch: fetchSpy });

    const data = new TextEncoder().encode('forged');
    const forgedSig = signEd25519(attackerKey, data); // signed by a different key

    expect(await plugin.verifySignature(peerDid, data, forgedSig)).toBe(false);
  });
});
