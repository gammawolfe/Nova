// packages/shared/src/did-document.ts
//
// Build a W3C DID Core document for Nova's gateway identity. Used by the
// /.well-known/did.json endpoint when Nova publishes a `did:web:<host>`
// identifier alongside its existing `did:key:` form, and by tests/peers that
// need to construct or compare documents.
//
// Spec refs:
//   - DID Core: https://www.w3.org/TR/did-core/
//   - did:web Method: https://w3c-ccg.github.io/did-method-web/
//   - Multibase / Multicodec for Ed25519 public keys:
//       multicodec ed25519-pub = 0xed (varint), encoded as 0xed 0x01.
//       publicKeyMultibase = "z" + base58btc(prefix || rawKey32)
//
// We deliberately keep the document small and additive: the only key Nova
// publishes is its gateway Ed25519 signing key, with `assertionMethod` and
// `authentication` both pointing at the same verification method id. Extra
// service entries (handle resolver, A2A endpoint) are caller-supplied so the
// shared helper has no a2a-server-specific knowledge.

import { KeyObject, createPublicKey } from 'crypto';
import bs58 from 'bs58';

/**
 * Multicodec prefix for ed25519-pub (varint-encoded 0xed → bytes 0xed 0x01).
 * Concatenate with the raw 32-byte public key, then base58btc-encode and
 * prefix with "z" to get a multibase string.
 */
const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);

/**
 * SPKI DER prefix for Ed25519 public keys (12 bytes), followed by the raw
 * 32-byte key. Used to slice the raw key out of Node's SPKI export without
 * pulling in an asn.1 parser.
 */
const ED25519_SPKI_PREFIX_LEN = 12;
const ED25519_RAW_KEY_LEN = 32;

export interface DidVerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020';
  controller: string;
  publicKeyMultibase: string;
}

export interface DidService {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export interface DidDocument {
  '@context': string[];
  id: string;
  verificationMethod: DidVerificationMethod[];
  assertionMethod: string[];
  authentication: string[];
  alsoKnownAs?: string[];
  service?: DidService[];
}

/**
 * Encode an Ed25519 public key as a multibase publicKeyMultibase string.
 * Accepts either a 32-byte raw key or a Node KeyObject.
 */
export function ed25519PublicKeyToMultibase(key: KeyObject | Uint8Array): string {
  const raw = key instanceof Uint8Array ? key : extractRawEd25519PublicKey(key);
  if (raw.length !== ED25519_RAW_KEY_LEN) {
    throw new Error(`Expected 32-byte Ed25519 public key, got ${raw.length}`);
  }
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + raw.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(raw, ED25519_MULTICODEC_PREFIX.length);
  return 'z' + bs58.encode(prefixed);
}

/**
 * Inverse of ed25519PublicKeyToMultibase. Used by the did:web plugin when
 * reading a peer Nova's published key.
 */
export function multibaseToEd25519PublicKey(multibase: string): Uint8Array {
  if (!multibase.startsWith('z')) {
    throw new Error(`Expected base58btc multibase ('z' prefix), got: ${multibase.slice(0, 4)}…`);
  }
  const decoded = bs58.decode(multibase.slice(1));
  if (decoded.length !== ED25519_MULTICODEC_PREFIX.length + ED25519_RAW_KEY_LEN) {
    throw new Error(`Decoded key has wrong length ${decoded.length}`);
  }
  for (let i = 0; i < ED25519_MULTICODEC_PREFIX.length; i++) {
    if (decoded[i] !== ED25519_MULTICODEC_PREFIX[i]) {
      throw new Error('Decoded key is not ed25519-pub multicodec');
    }
  }
  return decoded.subarray(ED25519_MULTICODEC_PREFIX.length);
}

/**
 * Slice the raw 32-byte Ed25519 public key out of a Node KeyObject's SPKI
 * DER export. Avoids a JWK round-trip — the SPKI form is fixed-shape for
 * Ed25519, so a constant-offset slice is safe.
 */
function extractRawEd25519PublicKey(key: KeyObject): Uint8Array {
  const pub = key.type === 'public' ? key : createPublicKey(key);
  const spkiDer = pub.export({ format: 'der', type: 'spki' });
  return Uint8Array.from(spkiDer.subarray(ED25519_SPKI_PREFIX_LEN, ED25519_SPKI_PREFIX_LEN + ED25519_RAW_KEY_LEN));
}

export function buildDidDocument(opts: {
  /** Canonical DID, e.g. "did:web:nova.family.com". */
  did: string;
  /** Ed25519 public or private key — public is extracted if needed. */
  publicKey: KeyObject;
  /** Equivalent identifiers (e.g. did:key form), advertised for federation. */
  alsoKnownAs?: string[];
  /** Service endpoints (handle resolver, A2A entrypoint, etc.). */
  services?: DidService[];
  /** Verification method id suffix; defaults to "#gateway". */
  keyFragment?: string;
}): DidDocument {
  const fragment = opts.keyFragment ?? 'gateway';
  const vmId = `${opts.did}#${fragment}`;
  const doc: DidDocument = {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: opts.did,
    verificationMethod: [{
      id: vmId,
      type: 'Ed25519VerificationKey2020',
      controller: opts.did,
      publicKeyMultibase: ed25519PublicKeyToMultibase(opts.publicKey),
    }],
    assertionMethod: [vmId],
    authentication: [vmId],
  };
  if (opts.alsoKnownAs && opts.alsoKnownAs.length > 0) doc.alsoKnownAs = opts.alsoKnownAs;
  if (opts.services && opts.services.length > 0) doc.service = opts.services;
  return doc;
}

/**
 * Resolve a `did:web:<host>[:path...]` DID to the URL where its DID document
 * is published. Per the did:web spec:
 *
 *   did:web:nova.family.com               → https://nova.family.com/.well-known/did.json
 *   did:web:nova.family.com:agents:books  → https://nova.family.com/agents/books/did.json
 *
 * Path segments after the host are colon-separated in the DID and become
 * slash-separated in the URL. Percent-encoded ports survive intact.
 */
export function didWebToUrl(did: string): string {
  if (!did.startsWith('did:web:')) {
    throw new Error(`Not a did:web DID: ${did}`);
  }
  const parts = did.slice('did:web:'.length).split(':');
  const host = decodeURIComponent(parts[0]!);
  const pathSegs = parts.slice(1).map(decodeURIComponent);
  if (pathSegs.length === 0) {
    return `https://${host}/.well-known/did.json`;
  }
  return `https://${host}/${pathSegs.join('/')}/did.json`;
}
