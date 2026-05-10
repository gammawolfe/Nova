import fsp from 'fs/promises';
import path from 'path';
import { validate as ucansValidate } from '@ucans/ucans';
import { TenantContext, DATA_ROOT } from '@nova/shared/src/tenant';
import { logger } from '@nova/shared/src/logger';
import {
  computeCid,
  parseUcanJwt,
  capsSubsumeAll,
  UcanCapability,
  UcanPayload,
} from '@nova/shared/src/ucan';

export interface UCANVerificationResult {
  valid: boolean;
  reason?: string;
  issuerDid?: string;
  grantCid?: string;
}

/**
 * Verify a sender-signed delegation-chain UCAN at ingress.
 *
 * Token shape expected:
 *
 *   outer (invocation):
 *     iss: sender agent DID
 *     aud: Nova gateway DID
 *     att: [narrow destination-scoped capability]
 *     prf: [grantJwt]
 *     exp: short (minutes)
 *
 *   prf[0] (approval grant):
 *     iss: Nova gateway DID
 *     aud: sender agent DID
 *     att: [broad tenant-scoped capability]
 *     prf: []
 *     exp: long (~30 days)
 *
 * Checks:
 *   1. Outer signature + expiry (via @ucans/ucans, which derives the signing
 *      pubkey from the outer iss did:key).
 *   2. Outer aud === Nova's gateway DID.
 *   3. Outer has at least one prf entry — the approval grant.
 *   4. Grant signature + expiry (pubkey derived from grant iss did:key; this
 *      iss is equal to novaDid, so the signing key is Nova's).
 *   5. Grant iss === novaDid (can't be bypassed with an arbitrary root token).
 *   6. Grant aud === outer iss (chain linkage — the grant was issued to this
 *      sender specifically).
 *   7. Grant att subsumes outer att (delegation is narrowing, not widening).
 *   8. Outer att subsumes the required capability (the invocation actually
 *      authorizes this specific destination + skill).
 *   9. Neither outer CID nor grant CID is in the per-tenant revocation
 *      tombstone directory. Revoking the grant cascades to every invocation
 *      derived from it — which is why invocation tokens are ephemeral (5 min)
 *      and don't individually need to be revoked.
 */
export async function verifyUCAN(
  ucanJwt: string,
  ctx: TenantContext,
  novaDid: string,
  requiredScope: string,
): Promise<UCANVerificationResult> {
  let outer: { payload: UcanPayload };
  try {
    outer = parseUcanJwt(ucanJwt);
  } catch {
    return { valid: false, reason: 'ucan_malformed' };
  }

  // 1. Outer signature + expiry
  try {
    await ucansValidate(ucanJwt);
  } catch (err: any) {
    const msg: string = (err.message ?? '').toLowerCase();
    if (msg.includes('expir')) return { valid: false, reason: 'ucan_expired' };
    logger.warn({ err: err.message }, 'Outer UCAN validation failed');
    return { valid: false, reason: 'ucan_invalid_signature' };
  }

  // 2. Outer aud check
  if (outer.payload.aud !== novaDid) {
    return { valid: false, reason: 'ucan_wrong_audience' };
  }

  // 3. Proof chain present
  const proofs = outer.payload.prf ?? [];
  if (proofs.length === 0 || !proofs[0]) {
    return { valid: false, reason: 'ucan_no_proof' };
  }
  const grantJwt = proofs[0];

  // 4. Grant signature + expiry
  try {
    await ucansValidate(grantJwt);
  } catch (err: any) {
    const msg: string = (err.message ?? '').toLowerCase();
    if (msg.includes('expir')) return { valid: false, reason: 'grant_expired' };
    logger.warn({ err: err.message }, 'Grant UCAN validation failed');
    return { valid: false, reason: 'grant_invalid_signature' };
  }

  let grant: { payload: UcanPayload };
  try {
    grant = parseUcanJwt(grantJwt);
  } catch {
    return { valid: false, reason: 'grant_malformed' };
  }

  // 5. Grant iss = novaDid (root of trust)
  if (grant.payload.iss !== novaDid) {
    return { valid: false, reason: 'grant_not_from_nova' };
  }
  // 6. Grant aud = outer iss (chain linkage)
  if (grant.payload.aud !== outer.payload.iss) {
    return { valid: false, reason: 'grant_wrong_audience' };
  }

  // 7. Grant subsumes outer (narrowing only)
  if (!capsSubsumeAll(grant.payload.att, outer.payload.att)) {
    return { valid: false, reason: 'grant_does_not_subsume_invocation' };
  }

  // 8. Invocation targets this destination — the invocation's capabilities
  // must fall within the destination's namespace. requiredScope is the broad
  // `nova:<destTenant>:<destAgent>:skill:*` envelope; the invocation's att can
  // be this or narrower (e.g. a specific skill ID).
  const destEnvelope: UcanCapability[] = [{ with: requiredScope, can: 'invoke' }];
  if (!capsSubsumeAll(destEnvelope, outer.payload.att)) {
    return { valid: false, reason: 'ucan_insufficient_capability' };
  }

  // 9. Revocation — check both the invocation CID and the grant CID against
  // the global tombstone directory. UCAN CIDs are sha256 hashes (globally
  // unique), so revocation is cross-tenant; this is the same path that
  // admin-api writes to in revokeUcan() and that a2a-server's status route
  // reads. ENOENT means "not revoked"; any other I/O error fails closed —
  // we'd rather quarantine a legitimate task than admit a possibly-revoked
  // one because the disk is misbehaving.
  const revokedDir = path.join(DATA_ROOT, 'ucans', 'revoked');
  const outerCid = computeCid(ucanJwt);
  const grantCid = computeCid(grantJwt);
  for (const cid of [outerCid, grantCid]) {
    const revokedPath = path.join(revokedDir, cid + '.json');
    try {
      await fsp.access(revokedPath);
      return { valid: false, reason: 'ucan_revoked' };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue; // not revoked — continue
      logger.warn({ err: (err as Error).message, code, cid }, 'Revocation check I/O error — failing closed');
      return { valid: false, reason: 'revocation_check_failed' };
    }
  }

  return { valid: true, issuerDid: outer.payload.iss, grantCid };
}

/**
 * Decode the outer UCAN JWT and return the issuer DID without full validation.
 *
 * In the sender-signed delegation model, `iss` is the sender agent's DID — the
 * value the gate uses for trust-tier resolution before launching the expensive
 * signature-verification step.
 */
export function extractIssuerDid(ucanJwt: string): string | null {
  try {
    const { payload } = parseUcanJwt(ucanJwt);
    return payload.iss || null;
  } catch {
    return null;
  }
}
