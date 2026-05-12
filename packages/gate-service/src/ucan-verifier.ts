import fsp from 'fs/promises';
import path from 'path';
import { novaUcansValidate } from '@nova/shared/src/ucan-plugins';
import { TenantContext, DATA_ROOT } from '@nova/shared/src/tenant';
import { logger } from '@nova/shared/src/logger';
import { loadTrustedIssuers, isTrustedPeerDid } from '@nova/shared/src/trusted-issuers';
import {
  computeCid,
  parseUcanJwt,
  capsSubsumeAll,
  walkUcanChain,
  UcanCapability,
  UcanPayload,
} from '@nova/shared/src/ucan';

export interface UCANVerificationResult {
  valid: boolean;
  reason?: string;
  issuerDid?: string;
  /** CID of the immediate proof (depth=1 link). Preserved for audit-log compatibility. */
  grantCid?: string;
  /** Depth at which validation failed (0 = outer, 1 = grant, …). Undefined on success. */
  chainDepth?: number;
  /**
   * Full chain length on success: 2 for a today-style self-rooted single-link
   * grant (outer + 1 root proof); 3+ for federation chains. Undefined on
   * failure.
   */
  chainLength?: number;
  /**
   * Audience of the chain root for federation chains (`aud` of the
   * Nova-signed federation grant — i.e. the peer Nova we delegated to).
   * Undefined for single-link (non-federation) chains where the root's
   * audience is just the local sender. Surfaced for audit-log enrichment
   * so operators can attribute federated requests to a peer.
   */
  peerDid?: string;
}

/**
 * Verify a sender-signed UCAN at ingress, accepting both today's single-link
 * self-rooted grants AND multi-link federation chains rooted at Nova's DID.
 *
 * Outer (invocation) token:
 *   iss: sender agent DID
 *   aud: this Nova's gateway DID
 *   att: [destination-scoped capability]
 *   prf: [link1Jwt]                ← exactly one
 *   exp: short (minutes)
 *
 * Chain (walking outer → root):
 *   - Each non-root link has exactly one proof in `prf`.
 *   - link[i].aud === link[i-1].iss  (audience linkage)
 *   - link[i].att subsumes link[i-1].att  (monotonic narrowing — never widens)
 *   - Root link has iss === novaDid AND prf: [] (cryptographic anchor;
 *     trust is established by walking back to our own signature, not by
 *     trusting any intermediate issuer).
 *
 * For chains of length > 1 (federation case), the penultimate hop's
 * audience must also be present in the operator's `trusted-issuers.json`
 * allowlist. This is defense-in-depth: cryptographic validity is necessary
 * but the operator wants explicit opt-in for which peer Novas may carry
 * delegations. Removing a peer from the list is a kill switch independent
 * of CID revocation. Single-link chains (no federation) skip this check —
 * the root IS Nova, no peer is involved.
 *
 * Validation order (each check is cheap → expensive):
 *   1. Outer parses                                  → ucan_malformed
 *   2. Outer signature + expiry                      → ucan_invalid_signature / ucan_expired
 *   3. Outer aud === novaDid                         → ucan_wrong_audience
 *   4. Outer att covers requiredScope                → ucan_insufficient_capability
 *   5. Outer has at least one proof                  → ucan_no_proof
 *   6. Chain walks to a novaDid-rooted link          → chain_* reasons (with depth)
 *   7. Trusted-peer check (chains length > 1 only)   → chain_peer_untrusted
 *   8. Revocation tombstone for any link             → ucan_revoked / revocation_check_failed
 */
export async function verifyUCAN(
  ucanJwt: string,
  _ctx: TenantContext,
  novaDid: string,
  requiredScope: string,
): Promise<UCANVerificationResult> {
  let outer: { payload: UcanPayload };
  try {
    outer = parseUcanJwt(ucanJwt);
  } catch {
    return { valid: false, reason: 'ucan_malformed' };
  }

  // 1. Outer signature + expiry. Validated separately from the chain walk so
  //    a forged outer surfaces as `ucan_invalid_signature` rather than
  //    `chain_link_invalid_signature at depth 0`.
  try {
    await novaUcansValidate(ucanJwt);
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

  // 3. Invocation targets this destination — done before the chain walk so
  //    we don't pay signature cost on calls aimed at the wrong agent.
  const destEnvelope: UcanCapability[] = [{ with: requiredScope, can: 'invoke' }];
  if (!capsSubsumeAll(destEnvelope, outer.payload.att)) {
    return { valid: false, reason: 'ucan_insufficient_capability' };
  }

  // 4. Outer must carry at least one proof. Surfaced as the legacy reason
  //    `ucan_no_proof` rather than chain_link_missing_proof at depth 0;
  //    keeps the existing observability contract.
  if ((outer.payload.prf?.length ?? 0) === 0) {
    return { valid: false, reason: 'ucan_no_proof' };
  }

  // 5. Walk the chain from outer back to a Nova-rooted link.
  const chain = await walkUcanChain(
    { jwt: ucanJwt, payload: outer.payload },
    novaDid,
    novaUcansValidate,
  );
  if (!chain.ok) {
    return { valid: false, reason: chain.reason, chainDepth: chain.depth };
  }

  // 6. Trusted-peer defense-in-depth. For federation chains (depth > 1), the
  //    chain root is Nova's own delegation to a peer Nova (signed by us,
  //    aud = the peer). That peer's DID must be in the operator's
  //    trusted-issuers list. The chain itself proves delegation
  //    cryptographically; this check is the operator's kill switch that
  //    cuts off a peer without revoking individual grant CIDs.
  if (chain.depth > 1) {
    const peerDid = chain.root.payload.aud;
    const trusted = await loadTrustedIssuers();
    if (!isTrustedPeerDid(peerDid, trusted)) {
      logger.warn({ peerDid, chainDepth: chain.depth }, 'Federation chain rejected: peer not in trusted-issuers');
      return { valid: false, reason: 'chain_peer_untrusted', chainDepth: chain.depth };
    }
  }

  // 7. Revocation — check every link in the chain.
  const revokedDir = path.join(DATA_ROOT, 'ucans', 'revoked');
  for (const cid of chain.cids) {
    const revokedPath = path.join(revokedDir, cid + '.json');
    try {
      await fsp.access(revokedPath);
      return { valid: false, reason: 'ucan_revoked' };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      logger.warn({ err: (err as Error).message, code, cid }, 'Revocation check I/O error — failing closed');
      return { valid: false, reason: 'revocation_check_failed' };
    }
  }

  // grantCid is the immediate proof (cids[1]). chainLength is total link count.
  // peerDid is the chain root's aud for federation chains — undefined for
  // single-link (depth=1) chains because the root's aud is just the local
  // sender, which is already surfaced as `issuerDid`.
  const grantCid = chain.cids[1];
  const result: UCANVerificationResult = {
    valid: true,
    issuerDid: outer.payload.iss,
    chainLength: chain.cids.length,
  };
  if (grantCid !== undefined) result.grantCid = grantCid;
  if (chain.depth > 1) result.peerDid = chain.root.payload.aud;
  return result;
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
