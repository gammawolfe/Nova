import crypto from 'crypto';
import fsp from 'fs/promises';
import { validate as ucansValidate, parse as ucansParse } from '@ucans/ucans';
import { TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { ActorRecord } from '@nova/shared/src/types';
import { logger } from '@nova/shared/src/logger';

export interface UCANVerificationResult {
  valid: boolean;
  reason?: string;
  issuerDid?: string;
}

/**
 * Step 3 — Verify the UCAN JWT cryptographically.
 *
 * Checks (in order):
 * 1. JWT signature and expiry via ucans.validate()
 * 2. Issuer DID matches the registered actor record
 * 3. Audience DID matches this Nova agent's DID
 * 4. Capability chain contains required prefix or wildcard
 * 5. Not in the revocation list
 *
 * All failures are quarantine events (not drops) — sender may need to renew.
 */
export async function verifyUCAN(
  ucanJwt: string,
  actorRecord: ActorRecord,
  agentDid: string,
  ctx: TenantContext
): Promise<UCANVerificationResult> {
  // 1. Validate signature + expiry
  let decoded: Awaited<ReturnType<typeof ucansParse>>;
  try {
    await ucansValidate(ucanJwt);
    decoded = await ucansParse(ucanJwt);
  } catch (err: any) {
    const msg: string = err.message || '';
    if (msg.toLowerCase().includes('expir')) {
      return { valid: false, reason: 'ucan_expired' };
    }
    logger.warn({ err: err.message }, 'UCAN signature validation failed');
    return { valid: false, reason: 'ucan_invalid_jwt' };
  }

  const payload = decoded.payload;

  // 2. Issuer DID must match registered actor
  if (payload.iss !== actorRecord.did) {
    logger.warn(
      { expected: actorRecord.did, received: payload.iss },
      'UCAN DID mismatch — possible key theft'
    );
    return { valid: false, reason: 'ucan_did_mismatch' };
  }

  // 3. Audience must be this agent's DID
  if (payload.aud !== agentDid) {
    return { valid: false, reason: 'ucan_wrong_audience' };
  }

  // 4. Capability check — must include nova:task/* or the specific nova:{tenantId}:{agentId} prefix
  // att.with is a ResourcePointer { scheme, hierPart } from ucans.parse()
  const requiredPrefix = `nova:${ctx.tenantId}:${ctx.agentId}`;
  const hasCapability = payload.att.some((att: any) => {
    const w = att.with;
    if (!w) return false;
    // Handle both string and ResourcePointer formats
    const wStr = typeof w === 'string' ? w : `${w.scheme}:${w.hierPart}`;
    return wStr === 'nova:task/*' || wStr.startsWith(requiredPrefix);
  });
  if (!hasCapability) {
    return { valid: false, reason: 'ucan_insufficient_capability' };
  }

  // 5. Revocation check — check for CID tombstone file
  // We use sha256(jwt) as the stable CID-equivalent (avoids @web3-storage/content dependency)
  const cid = crypto.createHash('sha256').update(ucanJwt).digest('hex');
  const revokedPath = tenantDataPath(ctx, '..', 'ucans', 'revoked', cid + '.json');
  try {
    await fsp.access(revokedPath);
    return { valid: false, reason: 'ucan_revoked' };
  } catch {
    // Not revoked
  }

  return { valid: true, issuerDid: payload.iss };
}

/**
 * Decode the UCAN JWT and extract the issuer DID without full validation.
 * Used in Step 1 to get the DID for trust tier lookup before full verification.
 */
export function extractIssuerDid(ucanJwt: string): string | null {
  try {
    // UCAN JWT is base64url-encoded header.payload.signature
    const parts = ucanJwt.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.iss || null;
  } catch {
    return null;
  }
}
