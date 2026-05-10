// packages/shared/test/did-document.test.ts
//
// Unit tests for DID document construction and multibase key encoding.

import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createPublicKey } from 'crypto';
import {
  buildDidDocument,
  buildDidWeb,
  ed25519PublicKeyToMultibase,
  multibaseToEd25519PublicKey,
  didWebToUrl,
  validateDidWebHost,
} from '../src/did-document';

function makeEd25519Pair() {
  return generateKeyPairSync('ed25519');
}

describe('ed25519PublicKeyToMultibase / multibaseToEd25519PublicKey', () => {
  it('round-trips a generated Ed25519 public key', () => {
    const { publicKey } = makeEd25519Pair();
    const mb = ed25519PublicKeyToMultibase(publicKey);
    expect(mb).toMatch(/^z[1-9A-HJ-NP-Za-km-z]+$/);

    const raw = multibaseToEd25519PublicKey(mb);
    expect(raw.length).toBe(32);

    // Encoding the round-tripped raw key as a JWK should produce a key
    // that exports an SPKI matching the original.
    const reconstructed = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    });
    const origDer = publicKey.export({ format: 'der', type: 'spki' });
    const newDer = reconstructed.export({ format: 'der', type: 'spki' });
    expect(newDer.equals(origDer)).toBe(true);
  });

  it('rejects multibase strings that are not base58btc', () => {
    expect(() => multibaseToEd25519PublicKey('NotMultibase')).toThrow(/base58btc/);
  });

  it('rejects multibase strings that decode to the wrong length', () => {
    // 'z' + base58 of three bytes — not 34 bytes total.
    expect(() => multibaseToEd25519PublicKey('z2g')).toThrow(/length/);
  });
});

describe('buildDidDocument', () => {
  it('produces a minimal DID document with one verification method', () => {
    const { publicKey } = makeEd25519Pair();
    const doc = buildDidDocument({
      did: 'did:web:nova.family.com',
      publicKey,
    });

    expect(doc['@context']).toContain('https://www.w3.org/ns/did/v1');
    expect(doc.id).toBe('did:web:nova.family.com');
    expect(doc.verificationMethod).toHaveLength(1);
    expect(doc.verificationMethod[0]!.type).toBe('Ed25519VerificationKey2020');
    expect(doc.verificationMethod[0]!.id).toBe('did:web:nova.family.com#gateway');
    expect(doc.verificationMethod[0]!.controller).toBe('did:web:nova.family.com');
    expect(doc.assertionMethod).toEqual([doc.verificationMethod[0]!.id]);
    expect(doc.authentication).toEqual([doc.verificationMethod[0]!.id]);
  });

  it('omits alsoKnownAs and service when empty', () => {
    const { publicKey } = makeEd25519Pair();
    const doc = buildDidDocument({ did: 'did:web:nova.family.com', publicKey });
    expect(doc.alsoKnownAs).toBeUndefined();
    expect(doc.service).toBeUndefined();
  });

  it('includes alsoKnownAs and services when supplied', () => {
    const { publicKey } = makeEd25519Pair();
    const doc = buildDidDocument({
      did: 'did:web:nova.family.com',
      publicKey,
      alsoKnownAs: ['did:key:z6MkAlice'],
      services: [{ id: '#a2a', type: 'NovaA2A', serviceEndpoint: 'https://nova.family.com' }],
    });
    expect(doc.alsoKnownAs).toEqual(['did:key:z6MkAlice']);
    expect(doc.service).toEqual([{ id: '#a2a', type: 'NovaA2A', serviceEndpoint: 'https://nova.family.com' }]);
  });

  it('honours a custom keyFragment', () => {
    const { publicKey } = makeEd25519Pair();
    const doc = buildDidDocument({
      did: 'did:web:nova.family.com',
      publicKey,
      keyFragment: 'main',
    });
    expect(doc.verificationMethod[0]!.id).toBe('did:web:nova.family.com#main');
  });
});

describe('didWebToUrl', () => {
  it('maps a host-only did:web to /.well-known/did.json', () => {
    expect(didWebToUrl('did:web:nova.family.com')).toBe('https://nova.family.com/.well-known/did.json');
  });

  it('maps a path-suffixed did:web to a path-relative did.json', () => {
    expect(didWebToUrl('did:web:nova.family.com:agents:books'))
      .toBe('https://nova.family.com/agents/books/did.json');
  });

  it('decodes percent-encoded port in the host segment', () => {
    expect(didWebToUrl('did:web:nova.family.com%3A8443'))
      .toBe('https://nova.family.com:8443/.well-known/did.json');
  });

  it('rejects non-did:web inputs', () => {
    expect(() => didWebToUrl('did:key:z6Mk')).toThrow(/Not a did:web/);
  });
});

describe('validateDidWebHost', () => {
  it('accepts a bare hostname', () => {
    expect(validateDidWebHost('nova.family.com')).toBe('nova.family.com');
  });

  it('accepts a hostname with port', () => {
    expect(validateDidWebHost('nova.family.com:8443')).toBe('nova.family.com:8443');
  });

  it('accepts hostnames with hyphens', () => {
    expect(validateDidWebHost('nova-staging.example.com')).toBe('nova-staging.example.com');
  });

  it('rejects empty input', () => {
    expect(() => validateDidWebHost('')).toThrow(/Invalid did:web host/);
  });

  it('rejects schemes', () => {
    expect(() => validateDidWebHost('https://nova.family.com')).toThrow(/Invalid did:web host/);
  });

  it('rejects paths', () => {
    expect(() => validateDidWebHost('nova.family.com/path')).toThrow(/Invalid did:web host/);
  });

  it('rejects whitespace', () => {
    expect(() => validateDidWebHost('nova.family.com ')).toThrow(/Invalid did:web host/);
  });

  it('rejects underscores (not valid DNS labels)', () => {
    expect(() => validateDidWebHost('nova_family.com')).toThrow(/Invalid did:web host/);
  });
});

describe('buildDidWeb', () => {
  it('builds a host-only did:web', () => {
    expect(buildDidWeb('nova.family.com')).toBe('did:web:nova.family.com');
  });

  it('percent-encodes the port colon', () => {
    expect(buildDidWeb('nova.family.com:8443')).toBe('did:web:nova.family.com%3A8443');
  });

  it('round-trips with didWebToUrl on a host-only DID', () => {
    expect(didWebToUrl(buildDidWeb('nova.family.com')))
      .toBe('https://nova.family.com/.well-known/did.json');
  });

  it('round-trips with didWebToUrl on a port-suffixed DID', () => {
    expect(didWebToUrl(buildDidWeb('nova.family.com:8443')))
      .toBe('https://nova.family.com:8443/.well-known/did.json');
  });

  it('rejects invalid hosts (delegates to validateDidWebHost)', () => {
    expect(() => buildDidWeb('https://nova.family.com')).toThrow(/Invalid did:web host/);
  });
});
