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
