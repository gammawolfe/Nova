// packages/shared/src/trusted-issuers.ts
//
// Configurable allowlist of peer DIDs that this Nova accepts as inner-grant
// issuers in cross-Nova UCAN delegation chains.
//
// Today, the gate enforces `prf[0].iss === novaDid` — only self-issued
// approval grants are accepted. When Phase 2B introduces cross-Nova
// invocation, that check relaxes to:
//
//   prf[0].iss === novaDid  OR  isTrustedPeerDid(prf[0].iss, set)
//
// Landing the primitive ahead of the routing change keeps the cross-Nova
// PR focused on UCAN-chain semantics — config shape, file location, and
// validation rules are settled here.
//
// File format (data/keys/trusted-issuers.json):
//
//   { "trusted": ["did:web:nova.bookstore.com", "did:web:nova.alice.example"] }
//
// Either form is accepted: a top-level `{ trusted: [...] }` object (preferred,
// extensible) or a bare array of strings. Missing file → empty set
// (default-deny — every check returns false, which preserves today's
// "no peers accepted" behaviour).
//
// Validation is strict: malformed JSON throws, non-string entries throw,
// entries that don't begin with `did:` throw. Loud failure on
// misconfiguration is preferable to silently widening trust.
//
// Reload semantics: this module reads on demand. Callers should cache the
// returned Set for a request's lifetime. Live reload is intentionally not
// supported — restart-to-apply matches how the rest of Nova handles
// security-relevant configuration (nova.did, private key, gate config).

import fsp from 'fs/promises';
import path from 'path';
import { KEY_ROOT } from './tenant';

const TRUSTED_ISSUERS_FILE = path.join(KEY_ROOT, 'trusted-issuers.json');

export class TrustedIssuersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedIssuersError';
  }
}

/**
 * Load the trusted-issuers allowlist from disk. Returns an empty Set when
 * the file is absent. Throws TrustedIssuersError on any other problem
 * (malformed JSON, wrong shape, invalid entries) — callers should let
 * this surface so deployments fail to start with a clear error rather
 * than booting with a silently-wrong trust config.
 */
export async function loadTrustedIssuers(filePath = TRUSTED_ISSUERS_FILE): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return new Set();
    throw new TrustedIssuersError(`Failed to read ${filePath}: ${err.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new TrustedIssuersError(`Malformed JSON in ${filePath}: ${err.message}`);
  }

  let entries: unknown;
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).trusted)) {
    entries = (parsed as any).trusted;
  } else {
    throw new TrustedIssuersError(
      `${filePath} must be either an array of DIDs or { "trusted": [...] }`,
    );
  }

  const set = new Set<string>();
  for (const [i, entry] of (entries as unknown[]).entries()) {
    if (typeof entry !== 'string') {
      throw new TrustedIssuersError(`${filePath}[${i}] is not a string`);
    }
    if (!entry.startsWith('did:')) {
      throw new TrustedIssuersError(`${filePath}[${i}] is not a DID: "${entry}"`);
    }
    set.add(entry);
  }
  return set;
}

/**
 * Exact-match check against a trusted-issuers Set. No globs, no prefix
 * match — those invite operator mistakes (typo'd glob silently widens
 * trust) and we don't have a use case yet that requires them. Defer.
 */
export function isTrustedPeerDid(did: string, trusted: Set<string>): boolean {
  return trusted.has(did);
}
