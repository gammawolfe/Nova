// packages/a2a-server/src/auth/self-ucan.ts
//
// Self-UCAN verification adapter shared by broker-mode routes (inbox, replies).
// Self-UCANs are JWTs issued BY the calling agent's own did:key. We verify them
// with ucans.validate(), which:
//   • Decodes the JWT header/payload
//   • Extracts the Ed25519 public key from the did:key iss field
//   • Cryptographically verifies the JWT signature against that public key
//   • Checks the exp claim is in the future
//
// This replaces earlier no-op verifications that only base64-decoded the payload
// and performed no signature check, allowing any party who knows a target
// agent's public DID (visible via /discover) to forge a self-UCAN.

import { Request, Response } from 'express';
import { validate as ucansValidate, parse as ucansParse } from '@ucans/ucans';
import { getAgentMeta } from '@nova/shared/src/agent-index';
import { getSharedRedis } from '@nova/shared/src/redis';
import { TenantContext } from '@nova/shared/src/tenant';

interface SelfUcanResult {
  ok: true;
  subjectDid: string;
}
interface SelfUcanFailure {
  ok: false;
  reason: string;
}

/**
 * Cryptographic self-UCAN verification:
 * 1. Call ucans.validate() — performs Ed25519 signature verification by
 *    extracting the public key from the did:key `iss` field, and checks expiry.
 * 2. Parse the verified payload to extract `iss` as the subject DID.
 * 3. Return { ok: true, subjectDid } on success or { ok: false, reason } on failure.
 */
export async function verifySelfUcan(jwt: string): Promise<SelfUcanResult | SelfUcanFailure> {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts[1]) {
      return { ok: false, reason: 'malformed_jwt' };
    }

    await ucansValidate(jwt);

    const decoded = await ucansParse(jwt);
    const issuerDid: string | undefined = decoded.payload.iss;
    if (!issuerDid) {
      return { ok: false, reason: 'ucan_no_issuer' };
    }

    return { ok: true, subjectDid: issuerDid };
  } catch (err: any) {
    const msg: string = (err?.message ?? '').toLowerCase();
    if (msg.includes('expir')) {
      return { ok: false, reason: 'expired' };
    }
    if (msg.includes('signature') || msg.includes('invalid') || msg.includes('verify')) {
      return { ok: false, reason: 'signature_invalid' };
    }
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * Extract a self-UCAN from the Authorization header, verify it, and resolve the
 * authenticated agent by matching the JWT's `iss` DID against the registered
 * agent's DID. On success returns TenantContext; on failure sends a 4xx and
 * returns null.
 */
export async function authSelfUcan(
  req: Request,
  res: Response,
  paramAgentId: string,
): Promise<TenantContext | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'UCAN_MISSING' });
    return null;
  }
  const jwt = auth.slice(7).trim();

  const verification = await verifySelfUcan(jwt);
  if (!verification.ok) {
    res.status(401).json({ error: 'UCAN_INVALID', reason: verification.reason });
    return null;
  }

  const meta = await getAgentMeta(getSharedRedis(), paramAgentId);
  if (!meta) {
    res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    return null;
  }
  if (!meta.did) {
    res.status(401).json({ error: 'AGENT_DID_MISSING', hint: 'Agent record has no DID; re-register the agent' });
    return null;
  }
  if (meta.did !== verification.subjectDid) {
    res.status(401).json({ error: 'UCAN_DID_MISMATCH' });
    return null;
  }
  return { tenantId: meta.tenantId, agentId: meta.agentId };
}
