// packages/shared/src/ucan.ts
//
// Sender-signed delegation-chain UCAN primitives.
//
// Two token shapes in the new model:
//
//   1. Approval grant (Nova → sender agent)
//      { iss: novaDid, aud: sender.did, att: [tenant-scoped cap], prf: [] }
//      Issued once at operator approval. Stashed in Redis for one-time claim
//      by the sender via GET /register/status.
//
//   2. Invocation token (sender → Nova gateway, per request)
//      { iss: sender.did, aud: novaDid, att: [destination-scoped cap],
//        prf: [grantJwt], exp: now+5m }
//      Minted locally by the sender's MCP server for each task submission.
//      Nova verifies the chain: sender's signature, grant's signature, grant
//      subsumption of the invocation's narrower capability.

import crypto from 'crypto';

export const NOVA_UCAN_VERSION = '0.10.0';

export interface UcanHeader {
  alg: 'EdDSA';
  typ: 'JWT';
  ucv: string;
}

export interface UcanCapability {
  /** e.g. "nova:tenant_X:agent_Y:skill:*" or "nova:tenant_X:*" */
  with: string;
  can: 'invoke';
}

export interface UcanPayload {
  iss: string;          // DID of the signer
  aud: string;          // DID of the audience
  exp: number;          // Unix seconds
  nbf?: number;
  att: UcanCapability[];
  prf: string[];        // Proof chain — encoded UCAN JWTs
  jti: string;
}

export function encodeB64Url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function decodeB64UrlJson<T = unknown>(s: string): T {
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
}

/**
 * Stable identifier for revocation bookkeeping. sha256 of the JWT, truncated to
 * 32 hex chars to match the historical format in data/ucans/issued/ metadata.
 */
export function computeCid(jwt: string): string {
  return crypto.createHash('sha256').update(jwt).digest('hex').slice(0, 32);
}

/**
 * Build + sign a UCAN JWT with an Ed25519 private key.
 * Used for BOTH admin-side grant issuance and MCP-side invocation minting.
 */
export function buildUcanJwt(payload: UcanPayload, privateKey: crypto.KeyObject): string {
  const header: UcanHeader = { alg: 'EdDSA', typ: 'JWT', ucv: NOVA_UCAN_VERSION };
  const headerB64 = encodeB64Url(header);
  const payloadB64 = encodeB64Url(payload);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = crypto.sign(null, signingInput, privateKey);
  return `${headerB64}.${payloadB64}.${signature.toString('base64url')}`;
}

export interface ParsedUcan {
  header: UcanHeader;
  payload: UcanPayload;
  signature: string;
  jwt: string;
}

export function parseUcanJwt(jwt: string): ParsedUcan {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Malformed UCAN JWT');
  }
  return {
    header: decodeB64UrlJson<UcanHeader>(parts[0]),
    payload: decodeB64UrlJson<UcanPayload>(parts[1]),
    signature: parts[2],
    jwt,
  };
}

/**
 * Capability subsumption: does `broader` grant permission to `narrower`?
 *
 * Rules:
 *   - `can` must match exactly.
 *   - `with` matches exactly OR broader ends with ':*' and narrower begins
 *     with broader's prefix up to the '*'.
 *
 * Examples:
 *   "nova:t1:*"               subsumes "nova:t1:a1:skill:chat"    → true
 *   "nova:t1:a1:skill:*"      subsumes "nova:t1:a1:skill:chat"    → true
 *   "nova:t1:a1:skill:chat"   subsumes "nova:t1:a1:skill:chat"    → true
 *   "nova:t1:*"               subsumes "nova:t2:a1:skill:chat"    → false
 */
export function capSubsumes(broader: UcanCapability, narrower: UcanCapability): boolean {
  if (broader.can !== narrower.can) return false;
  if (broader.with === narrower.with) return true;
  if (broader.with.endsWith(':*')) {
    const prefix = broader.with.slice(0, -1); // include the trailing ':'
    return narrower.with.startsWith(prefix);
  }
  return false;
}

export function capsSubsumeAll(broader: UcanCapability[], narrower: UcanCapability[]): boolean {
  return narrower.every(n => broader.some(b => capSubsumes(b, n)));
}

/**
 * Result of walking a strict UCAN delegation chain from an outer token back
 * to a root signed by `expectedRootDid`.
 *
 * The chain is the linear sequence outer → outer.prf[0] → ... → root, where:
 *   - each non-root link has exactly one entry in `prf`
 *   - the root has an empty `prf`
 *   - link[i].aud === link[i+1].iss  (audience linkage)
 *   - link[i+1].att subsumes link[i].att  (monotonic narrowing)
 *
 * UCAN-spec `prf` is technically a set of independent proofs, but for Nova's
 * v1 federation model we accept the strict-chain interpretation only — it's
 * simpler to reason about, easier to audit, and matches the semantics of
 * existing single-link grants exactly. Future federations that need multi-
 * proof composition can relax this without breaking strict-chain callers.
 */
export interface ChainWalkSuccess {
  ok: true;
  /** CIDs of every link, ordered outer→root. cids[0] is the outer's CID. */
  cids: string[];
  /** Parsed root link (iss === expectedRootDid). */
  root: { jwt: string; payload: UcanPayload };
  /** Depth = length-of-chain - 1. A single-link "today" chain has depth 1. */
  depth: number;
}

export interface ChainWalkFailure {
  ok: false;
  reason:
    | 'chain_link_missing_proof'
    | 'chain_link_too_many_proofs'
    | 'chain_link_malformed'
    | 'chain_link_invalid_signature'
    | 'chain_link_expired'
    | 'chain_audience_mismatch'
    | 'chain_capability_widened'
    | 'chain_too_deep'
    | 'chain_no_root'
    | 'chain_root_has_proofs';
  /** Depth at which the failure was detected. 0 = the outer; 1 = its proof; etc. */
  depth: number;
}

export type ChainWalkResult = ChainWalkSuccess | ChainWalkFailure;

/**
 * Walk a UCAN delegation chain rooted at `expectedRootDid`. The caller has
 * already validated the outer token's signature + expiry separately (so that
 * mis-signed outers fail with a top-level reason, not as a "chain_link"
 * reason at depth 0); this function validates every link past the outer.
 *
 * `validateLink` is injected so the caller decides which Plugins instance
 * verifies each link's signature/expiry. Production callers pass
 * `novaUcansValidate` from `./ucan-plugins`; tests can inject a stub.
 *
 * Strict semantics:
 *   - Each non-root link must have exactly one proof in `prf`.
 *     `chain_link_missing_proof` / `chain_link_too_many_proofs`.
 *   - Each next-link.aud must equal current-link.iss.
 *     `chain_audience_mismatch`.
 *   - Each next-link.att must subsume current-link.att.
 *     `chain_capability_widened`.
 *   - Chain must terminate at a link whose iss === expectedRootDid AND
 *     whose `prf` is empty. `chain_no_root` / `chain_root_has_proofs`.
 *   - Depth is capped by `maxDepth` (default 8) to bound work and prevent
 *     a malicious sender from forcing the verifier to walk an absurdly
 *     long chain. `chain_too_deep`.
 */
export async function walkUcanChain(
  outer: { jwt: string; payload: UcanPayload },
  expectedRootDid: string,
  validateLink: (jwt: string) => Promise<unknown>,
  maxDepth = 8,
): Promise<ChainWalkResult> {
  const cids: string[] = [computeCid(outer.jwt)];
  let current = outer;
  let depth = 0;

  while (true) {
    // Is the current link the root?
    if (current.payload.iss === expectedRootDid) {
      if ((current.payload.prf?.length ?? 0) > 0) {
        return { ok: false, reason: 'chain_root_has_proofs', depth };
      }
      return { ok: true, cids, root: current, depth };
    }

    // Non-root. Bound the chain length before peeking at the next proof so
    // an attacker can't force us past maxDepth signature checks.
    if (depth >= maxDepth) {
      return { ok: false, reason: 'chain_too_deep', depth };
    }

    const proofs = current.payload.prf ?? [];
    if (proofs.length === 0) {
      // Reached end of chain without finding the root.
      return { ok: false, reason: 'chain_no_root', depth };
    }
    if (proofs.length > 1) {
      return { ok: false, reason: 'chain_link_too_many_proofs', depth };
    }
    const nextJwt = proofs[0];
    if (!nextJwt) {
      return { ok: false, reason: 'chain_link_missing_proof', depth };
    }

    const nextDepth = depth + 1;

    // Signature + expiry of the next link.
    try {
      await validateLink(nextJwt);
    } catch (err: any) {
      const msg: string = (err?.message ?? '').toLowerCase();
      if (msg.includes('expir')) {
        return { ok: false, reason: 'chain_link_expired', depth: nextDepth };
      }
      return { ok: false, reason: 'chain_link_invalid_signature', depth: nextDepth };
    }

    let next: { payload: UcanPayload };
    try {
      next = parseUcanJwt(nextJwt);
    } catch {
      return { ok: false, reason: 'chain_link_malformed', depth: nextDepth };
    }

    // Audience linkage: this proof's audience must be the holder
    // (current.iss). Catches both unrelated proofs slipped into the chain
    // and audience-substitution attacks.
    if (next.payload.aud !== current.payload.iss) {
      return { ok: false, reason: 'chain_audience_mismatch', depth: nextDepth };
    }

    // Capability subsumption: the proof must authorize at least what the
    // current link claims. Equivalent to "delegation is narrowing only" at
    // every depth, not just outer→grant.
    if (!capsSubsumeAll(next.payload.att, current.payload.att)) {
      return { ok: false, reason: 'chain_capability_widened', depth: nextDepth };
    }

    cids.push(computeCid(nextJwt));
    current = { jwt: nextJwt, payload: next.payload };
    depth = nextDepth;
  }
}
