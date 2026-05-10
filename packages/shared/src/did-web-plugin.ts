// packages/shared/src/did-web-plugin.ts
//
// `@ucans/core` plugin that teaches the UCAN library how to verify signatures
// where the issuer DID uses the `did:web` method. The default plugin set only
// understands `did:key` (where the public key is encoded in the DID itself);
// for `did:web` we have to fetch a DID document and extract the key.
//
// Two verification paths:
//
//   1. Self short-circuit. If the issuer DID equals our own gateway DID, we
//      use the locally-loaded public key directly. Avoids HTTP loops (the
//      gate calling its own a2a-server) and removes a network dependency
//      from the boot path of any service that verifies its own UCANs.
//
//   2. HTTP resolution + cache. For peer Novas, fetch
//      https://<host>/.well-known/did.json (or path-suffix variant per the
//      did:web spec), extract the Ed25519 verification method, and verify
//      the signature with Node crypto.
//
// Cache TTL is intentionally short (5 min default). DID document changes
// rarely but matter immediately when they do (key rotation, revocation), so
// we'd rather pay the round trip occasionally than carry a stale key for
// hours. The cache is in-process; for multi-instance Nova deployments each
// process holds its own copy, which is acceptable because misses just mean
// one more HTTP fetch.

import crypto, { KeyObject, createPublicKey } from 'crypto';
import { DidDocument, didWebToUrl, multibaseToEd25519PublicKey } from './did-document';

export interface DidMethodPlugin {
  checkJwtAlg: (did: string, jwtAlg: string) => boolean;
  verifySignature: (did: string, data: Uint8Array, sig: Uint8Array) => Promise<boolean>;
}

export interface DidWebPluginOptions {
  /** Our own gateway DID — verifications against this DID skip HTTP and use selfPublicKey. */
  selfDid?: string | undefined;
  /** Public key for selfDid. Required iff selfDid is set. */
  selfPublicKey?: KeyObject | undefined;
  /** Override the network fetcher (used by tests). */
  fetch?: (url: string) => Promise<DidDocument>;
  /** Cache TTL in milliseconds. Default 5 minutes. Set to 0 to disable. */
  cacheTtlMs?: number;
  /** Per-DID resolution timeout in milliseconds. Default 5 seconds. */
  resolveTimeoutMs?: number;
}

interface CacheEntry {
  doc: DidDocument;
  expiresAt: number;
}

export function createDidWebPlugin(opts: DidWebPluginOptions = {}): DidMethodPlugin {
  const cacheTtl = opts.cacheTtlMs ?? 5 * 60 * 1000;
  const resolveTimeout = opts.resolveTimeoutMs ?? 5000;
  const cache = new Map<string, CacheEntry>();

  const fetcher = opts.fetch ?? (async (url: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), resolveTimeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/did+json, application/json' } });
      if (!res.ok) throw new Error(`DID document fetch failed: ${url} → HTTP ${res.status}`);
      return await res.json() as DidDocument;
    } finally {
      clearTimeout(timer);
    }
  });

  const selfPubKey = opts.selfPublicKey
    ? (opts.selfPublicKey.type === 'public' ? opts.selfPublicKey : createPublicKey(opts.selfPublicKey))
    : null;

  async function resolveDocument(did: string): Promise<DidDocument> {
    const now = Date.now();
    const cached = cache.get(did);
    if (cached && cached.expiresAt > now) return cached.doc;

    const url = didWebToUrl(did);
    const doc = await fetcher(url);
    if (doc.id !== did) {
      throw new Error(`DID document id mismatch: requested ${did}, document declares ${doc.id}`);
    }
    if (cacheTtl > 0) cache.set(did, { doc, expiresAt: now + cacheTtl });
    return doc;
  }

  function ed25519KeyFromDoc(doc: DidDocument): KeyObject {
    // Pick the first Ed25519VerificationKey2020 entry. Nova publishes exactly
    // one; supporting key sets is a Phase 2 concern (key rotation overlap).
    const vm = doc.verificationMethod.find(v => v.type === 'Ed25519VerificationKey2020');
    if (!vm) throw new Error(`DID document ${doc.id} has no Ed25519VerificationKey2020 entry`);
    const raw = multibaseToEd25519PublicKey(vm.publicKeyMultibase);
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    });
  }

  return {
    checkJwtAlg(_did, jwtAlg) {
      // Nova only signs with Ed25519. UCANs claiming a different alg from a
      // did:web issuer fail closed — the operator should publish a separate
      // verification method type if they ever introduce a non-Ed25519 key.
      return jwtAlg === 'EdDSA';
    },

    async verifySignature(did, data, sig) {
      let publicKey: KeyObject;
      if (opts.selfDid && did === opts.selfDid) {
        if (!selfPubKey) {
          throw new Error('did-web-plugin: selfDid set but selfPublicKey missing');
        }
        publicKey = selfPubKey;
      } else {
        const doc = await resolveDocument(did);
        publicKey = ed25519KeyFromDoc(doc);
      }
      return crypto.verify(null, data, publicKey, sig);
    },
  };
}
