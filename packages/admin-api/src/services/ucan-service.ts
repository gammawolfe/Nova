import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';
import { loadNovaPrivateKey, loadNovaDid } from '@nova/shared/src/invites';
import { verifyAndConsumeNonce } from './nonce-service';
import * as agentService from './agent-service';
import * as trustService from './trust-service';
import { logger } from '@nova/shared/src/logger';
import { buildUcanJwt, computeCid, type UcanCapability, type UcanPayload } from '@nova/shared/src/ucan';

// ─────────────────────────────────────────────────────────────────────────────
// Sender-signed delegation-chain UCAN model.
//
// Nova no longer issues self-UCANs signed with its own key and presented back
// as the sender's bearer token (the "Nova-as-notary" model). Instead:
//
//   - At operator approval, Nova issues an **approval grant** — a UCAN where
//     iss = novaDid, aud = sender.did, att = broad tenant-scoped capability.
//     The sender holds this as its long-lived root-of-trust.
//
//   - When sending a task, the sender mints an **invocation token** locally
//     with its own private key: iss = sender.did, aud = novaDid, att = narrow
//     destination-scoped capability, prf = [grantJwt]. Nova verifies the chain
//     at ingress: the outer signature proves the sender authored the request;
//     the grant in prf proves Nova authorized the capability.
//
// This file issues the grants. Invocation minting happens client-side in
// @nova/mcp-server. Verification happens in @nova/gate-service.
// ─────────────────────────────────────────────────────────────────────────────

interface UcanMetadata {
  cid: string;
  issuedTo: string;        // subject DID — agent DID for grants, peer Nova DID for federation
  capabilities: string[];  // flattened "with" strings for convenience
  expiresAt: string;
  issuedAt: string;
  /**
   * Tenant scope. Set for tenant-issued approval grants. Omitted for
   * federation grants, which are Nova-level (operator-to-peer-Nova
   * delegations that aren't owned by any single tenant). Tenant-scoped
   * listings filter on equality, which naturally excludes records with
   * no `tenantId`.
   */
  tenantId?: string;
  revoked: boolean;
  /** Distinguishes operator-issued approval grants from federation grants. */
  kind: 'grant' | 'federation';
  /** Optional operator note (currently used by federation grants for audit). */
  note?: string;
}

const issuedDir = path.join(DATA_ROOT, 'ucans', 'issued');
const revokedDir = path.join(DATA_ROOT, 'ucans', 'revoked');

// ── Grant issuance ──────────────────────────────────────────────────────────

/**
 * Issue an approval grant to a sender agent.
 *
 * Produces a UCAN:
 *   iss: Nova gateway DID  (signs with Nova's private key)
 *   aud: subject DID       (the sender agent receiving the grant)
 *   att: capability list   (typically [{ with: "nova:<tenantId>:*", can: "invoke" }])
 *   prf: []                (root of the delegation chain)
 *   exp: now + expiryDays
 *
 * The sender carries this token as prf when minting narrower invocation tokens.
 * Revocation is keyed by cid (sha256(jwt) truncated to 32 hex); tombstoning a
 * grant invalidates every invocation derived from it, immediately.
 */
export async function issueApprovalGrant(tenantId: string, data: {
  subjectDid: string;
  capabilities: string[];
  expiryDays: number;
}): Promise<{ jwt: string; cid: string; expiresAt: string }> {
  const novaDid = await loadNovaDid();
  if (!novaDid) {
    throw new Error('Nova DID not found — run scripts/generate-keys.ts first');
  }
  if (!data.subjectDid) {
    throw new Error('issueApprovalGrant requires subjectDid');
  }

  const exp = Math.floor(Date.now() / 1000) + data.expiryDays * 86400;
  const expiresAt = new Date(exp * 1000).toISOString();

  const att: UcanCapability[] = data.capabilities.map(cap => ({ with: cap, can: 'invoke' }));

  const payload: UcanPayload = {
    iss: novaDid,
    aud: data.subjectDid,
    exp,
    att,
    prf: [],
    jti: crypto.randomUUID(),
  };

  const privateKey = await loadNovaPrivateKey();
  const jwt = buildUcanJwt(payload, privateKey);
  const cid = computeCid(jwt);

  await fsp.mkdir(issuedDir, { recursive: true });
  const metadata: UcanMetadata = {
    cid,
    issuedTo: data.subjectDid,
    capabilities: data.capabilities,
    expiresAt,
    issuedAt: new Date().toISOString(),
    tenantId,
    revoked: false,
    kind: 'grant',
  };
  await writeAtomicallyAsync(path.join(issuedDir, cid + '.json'), metadata);

  return { jwt, cid, expiresAt };
}

// ── Federation grant issuance ───────────────────────────────────────────────

/**
 * Issue a federation grant: a UCAN this Nova signs that delegates a scoped
 * set of capabilities to a peer Nova. The peer's users can then mint
 * invocations whose `prf` chain includes this grant, and our gate's chain
 * walker verifies authority back to our own signature.
 *
 * Produces a UCAN:
 *   iss: this Nova's gateway DID  (signed with our private key)
 *   aud: peer Nova's gateway DID  (did:web or did:key)
 *   att: [capability, ...]        (each as { with, can: 'invoke' })
 *   prf: []                       (root of the delegation chain)
 *   exp: now + expiryDays
 *
 * The JWT is returned for the operator to hand to the peer's operator
 * (out-of-band — e-mail, secure transfer, whatever). Persistence on this
 * side stores metadata only; if the operator loses the JWT they re-issue.
 *
 * Note: the peer Nova should ALSO appear in `data/keys/trusted-issuers.json`
 * (Phase 2A primitive) — minting a federation grant doesn't auto-trust the
 * peer in the chain verifier's defense-in-depth check. That's an
 * intentional two-step: minting is "I'm willing to issue you authority";
 * trusted-issuers is "I'm willing to accept invocations chained through
 * you." Operators may want to pre-issue grants without yet enabling them.
 */
export async function issueFederationGrant(data: {
  peerDid: string;
  scope: string[];
  expiryDays: number;
  note?: string | undefined;
}): Promise<{ jwt: string; cid: string; expiresAt: string; peerDid: string }> {
  const novaDid = await loadNovaDid();
  if (!novaDid) {
    throw new Error('Nova DID not found — run scripts/generate-keys.ts first');
  }
  if (!data.peerDid) {
    throw new Error('issueFederationGrant requires peerDid');
  }
  if (data.peerDid === novaDid) {
    throw new Error('issueFederationGrant: peerDid equals this Nova\'s DID — federation grants are for peer Novas, not self');
  }

  const exp = Math.floor(Date.now() / 1000) + data.expiryDays * 86400;
  const expiresAt = new Date(exp * 1000).toISOString();

  const att: UcanCapability[] = data.scope.map(cap => ({ with: cap, can: 'invoke' }));

  const payload: UcanPayload = {
    iss: novaDid,
    aud: data.peerDid,
    exp,
    att,
    prf: [],
    jti: crypto.randomUUID(),
  };

  const privateKey = await loadNovaPrivateKey();
  const jwt = buildUcanJwt(payload, privateKey);
  const cid = computeCid(jwt);

  await fsp.mkdir(issuedDir, { recursive: true });
  const metadata: UcanMetadata = {
    cid,
    issuedTo: data.peerDid,
    capabilities: data.scope,
    expiresAt,
    issuedAt: new Date().toISOString(),
    revoked: false,
    kind: 'federation',
    ...(data.note !== undefined ? { note: data.note } : {}),
  };
  await writeAtomicallyAsync(path.join(issuedDir, cid + '.json'), metadata);

  logger.info({ peerDid: data.peerDid, cid, scope: data.scope, expiresAt }, 'Federation grant issued');

  return { jwt, cid, expiresAt, peerDid: data.peerDid };
}

/**
 * List all issued federation grants (Nova-level, no tenant filter). Returns
 * metadata only — the JWT itself is not persisted; operators keep the copy
 * returned at issuance time.
 */
export async function listFederationGrants(): Promise<UcanMetadata[]> {
  let files: string[];
  try { files = (await fsp.readdir(issuedDir)).filter(f => f.endsWith('.json')); }
  catch { return []; }

  const all = await Promise.all(
    files.map(async f => {
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(issuedDir, f), 'utf8')) as UcanMetadata;
        if (meta.kind !== 'federation') return null;
        return meta;
      } catch { return null; }
    }),
  );
  return all.filter((m): m is UcanMetadata => m !== null);
}

// ── Revocation ──────────────────────────────────────────────────────────────

/**
 * Tombstone a grant by cid. Invalidates every invocation token that chains to
 * this grant as prf. Idempotent: returns false if the cid has no issued record.
 * Writes the tombstone under data/ucans/revoked/ — keyed by the same 32-char
 * cid used at issuance and at gate-side verification.
 */
export async function revokeUcan(cid: string): Promise<boolean> {
  const issuedPath = path.join(issuedDir, cid + '.json');
  let metadata: UcanMetadata;
  try {
    metadata = JSON.parse(await fsp.readFile(issuedPath, 'utf8'));
  } catch { return false; }

  metadata.revoked = true;
  await Promise.all([
    writeAtomicallyAsync(issuedPath, metadata),
    fsp.mkdir(revokedDir, { recursive: true }).then(() =>
      writeAtomicallyAsync(path.join(revokedDir, cid + '.json'), { cid, revokedAt: new Date().toISOString() })
    ),
  ]);

  return true;
}

export async function listUcans(tenantId: string, expiringWithin?: string): Promise<UcanMetadata[]> {
  let files: string[];
  try { files = (await fsp.readdir(issuedDir)).filter(f => f.endsWith('.json')); }
  catch { return []; }

  const cutoff = expiringWithin
    ? (() => {
        const days = parseInt(expiringWithin.replace(/d$/, ''), 10);
        return isNaN(days) ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      })()
    : null;

  const all = await Promise.all(
    files.map(async f => {
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(issuedDir, f), 'utf8')) as UcanMetadata;
        if (meta.tenantId !== tenantId) return null;
        if (cutoff && new Date(meta.expiresAt) > cutoff) return null;
        return meta;
      } catch { return null; }
    })
  );
  return all.filter((m): m is UcanMetadata => m !== null);
}

/**
 * Revoke every issued grant whose `issuedTo` matches the given DID in the
 * given tenant. Returns the list of revoked CIDs. Tolerates the revoked-dir
 * not existing yet (first-rotate case).
 *
 * Used by key rotation to invalidate the old DID's credentials atomically
 * with the public-key swap — otherwise a grant issued to the prior identity
 * would remain valid until natural expiry, and derived invocation tokens
 * would continue to verify.
 */
export async function revokeUcansForSubject(tenantId: string, did: string): Promise<string[]> {
  let files: string[];
  try { files = (await fsp.readdir(issuedDir)).filter(f => f.endsWith('.json')); }
  catch { return []; }

  const revoked: string[] = [];
  await Promise.all(files.map(async f => {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(issuedDir, f), 'utf8')) as UcanMetadata;
      if (meta.tenantId !== tenantId || meta.issuedTo !== did || meta.revoked) return;
      if (await revokeUcan(meta.cid)) revoked.push(meta.cid);
    } catch { /* skip corrupt records */ }
  }));
  return revoked;
}

// ── Agent key rotation (Proof-of-Possession of OLD key) ──────────────────────

/**
 * Rotate an agent's Ed25519 keypair while preserving its trust-registry
 * tier and allowed skills. The caller proves control of the current (old)
 * private key by signing `${nonce}|${newDid}|${newPublicKey}` — binding the
 * nonce to the intended new identity so a captured rotation request can't
 * be replayed with a different public key.
 *
 * Side effects, in order:
 *   1. Verify nonce (bound to oldDid + agentId) and signature against the
 *      currently-stored public key.
 *   2. Revoke every grant previously issued to oldDid in this tenant. This
 *      cascades through the delegation chain: every invocation token derived
 *      from those grants fails verification at the gate.
 *   3. Swap {did, publicKey} on agent-config and re-index.
 *   4. Remove old trust-registry actor; add new actor with the same tier +
 *      allowedSkills. A missing actor (reissue-after-approval edge case)
 *      degrades to tier-1 wildcard with a logged warning.
 *   5. Issue a fresh approval grant for the new DID.
 *
 * Same-tenant trust registry is rebuilt automatically. Cross-tenant trust
 * entries that reference oldDid become stale — those tenants must re-seed
 * their actor table with newDid before inter-tenant traffic resumes.
 */
export async function rotateAgentKey(
  tenantId: string,
  agentId: string,
  data: {
    oldDid: string;
    newDid: string;
    newPublicKey: string;
    nonce: string;
    signature: string;
  },
): Promise<{
  jwt: string;
  cid: string;
  expiresAt: string;
  newDid: string;
  revokedCids: string[];
  trustTier: number;
  allowedSkills: string[];
}> {
  const nonceCheck = verifyAndConsumeNonce(data.nonce, data.oldDid, agentId);
  if (!nonceCheck.valid) {
    const err: any = new Error(`Nonce verification failed: ${nonceCheck.reason}`);
    if (nonceCheck.reason === 'nonce_expired') err.status = 410;
    else if (['nonce_did_mismatch', 'nonce_agent_mismatch'].includes(nonceCheck.reason!)) err.status = 401;
    else err.status = 400;
    throw err;
  }

  const agent = await agentService.getAgent(tenantId, agentId);
  if (!agent) throw Object.assign(new Error(`Agent ${agentId} not found`), { status: 404 });
  if (agent.status !== 'active') {
    throw Object.assign(new Error(`Agent ${agentId} is not active (status: ${agent.status})`), { status: 409 });
  }
  if (agent.did !== data.oldDid) {
    throw Object.assign(new Error('oldDid does not match the agent\'s currently-registered DID'), { status: 401 });
  }
  if (!agent.publicKey) {
    throw Object.assign(new Error('Agent has no registered public key'), { status: 403 });
  }
  if (data.newDid === data.oldDid) {
    throw Object.assign(new Error('newDid must differ from oldDid'), { status: 400 });
  }

  // Verify PoP of OLD key over (nonce|newDid|newPublicKey). Using a delimiter
  // not allowed in did:key (the pipe byte never appears in base58 or hex)
  // means the three fields can't be re-ordered or merged.
  const signedMessage = Buffer.from(`${data.nonce}|${data.newDid}|${data.newPublicKey}`, 'utf8');
  try {
    const rawKeyBytes = Buffer.from(agent.publicKey, 'base64');
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiPrefix, rawKeyBytes]);
    const publicKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    const valid = crypto.verify(null, signedMessage, publicKey, Buffer.from(data.signature, 'base64url'));
    if (!valid) {
      throw Object.assign(new Error('Signature verification failed — invalid proof of possession of old key'), { status: 401 });
    }
  } catch (err: any) {
    if (err.status) throw err;
    throw Object.assign(new Error(`Signature verification failed: ${err.message}`), { status: 401 });
  }

  // Look up the existing trust-registry entry BEFORE mutation so we can
  // carry tier + allowedSkills forward. If the actor's been removed out-of-
  // band (legacy agent, or operator-driven cleanup), fall back to tier-1
  // wildcard — same degradation the reissue path uses, for consistency.
  const existingActor = await trustService.getActor({ tenantId, agentId }, data.oldDid);
  const trustTier = existingActor?.tier ?? 1;
  const allowedSkills = existingActor?.allowedSkills ?? ['*'];
  const displayName = existingActor?.displayName ?? agent.name;
  if (!existingActor) {
    logger.warn(
      { tenantId, agentId, oldDid: data.oldDid },
      'Trust-registry entry missing on key rotation — defaulting to wildcard tier-1',
    );
  }

  // Revoke before the swap — any concurrent invocation that chains to an old
  // grant fails closed at the gate rather than slipping through after the
  // agent record has been updated.
  const revokedCids = await revokeUcansForSubject(tenantId, data.oldDid);

  // Atomically swap {did, publicKey} — writeAtomicallyAsync uses tmp+rename.
  await agentService.updateAgent(tenantId, agentId, {
    did: data.newDid,
    publicKey: data.newPublicKey,
  });

  // Rebuild trust-registry entry under the new DID.
  await trustService.removeActor({ tenantId, agentId }, data.oldDid);
  await trustService.addActor({ tenantId, agentId }, {
    did: data.newDid,
    displayName,
    tier: trustTier,
    allowedSkills,
    notes: `Rotated from ${data.oldDid} at ${new Date().toISOString()}`,
  });

  // Issue the fresh approval grant. Tenant-broad scope so the new key can
  // mint invocations for any discovered destination — narrowing happens in
  // the invocation token at send time.
  const result = await issueApprovalGrant(tenantId, {
    subjectDid: data.newDid,
    capabilities: [`nova:${tenantId}:*`],
    expiryDays: 30,
  });

  logger.info(
    { tenantId, agentId, oldDid: data.oldDid, newDid: data.newDid, revokedCount: revokedCids.length, newCid: result.cid },
    'Agent key rotated',
  );

  return {
    ...result,
    newDid: data.newDid,
    revokedCids,
    trustTier,
    allowedSkills,
  };
}

// ── Operator-initiated reissue (no PoP required — admin-auth gated) ──────────

/**
 * Reissue an approval grant for an already-approved agent. Used when the
 * one-time claim has expired or been lost before the agent could pick it up.
 *
 * Always issues a tenant-broad grant (`nova:<tenantId>:*`). Per-skill narrowing
 * is enforced at the destination by its own registered skill list; the grant
 * doesn't need to be any tighter than the tenant envelope.
 *
 * Throws with .status=404 (agent missing), .status=409 (agent not active),
 * .status=412 (agent has no DID recorded). Trust-registry miss is tolerated
 * — the grant shape doesn't depend on the per-skill list anymore, so the
 * reissued grant is always tenant-broad regardless of prior tier entry.
 */
export async function reissueGrant(
  tenantId: string,
  agentId: string,
  opts: { expiryDays?: number } = {},
): Promise<{ jwt: string; cid: string; expiresAt: string; allowedSkills: string[]; trustTier: number }> {
  const agent = await agentService.getAgent(tenantId, agentId);
  if (!agent) throw Object.assign(new Error(`Agent ${agentId} not found`), { status: 404 });
  if (agent.status !== 'active') {
    throw Object.assign(new Error(`Agent ${agentId} is not active (status: ${agent.status})`), { status: 409 });
  }
  if (!agent.did) {
    throw Object.assign(new Error(`Agent ${agentId} has no DID recorded; approve it first`), { status: 412 });
  }

  let allowedSkills: string[] = ['*'];
  let trustTier = 1;
  const actor = await trustService.getActor({ tenantId, agentId }, agent.did);
  if (actor) {
    allowedSkills = actor.allowedSkills;
    trustTier = actor.tier;
  } else {
    logger.warn(
      { tenantId, agentId, did: agent.did },
      'Trust-registry entry missing on reissue — defaulting to wildcard tier-1',
    );
  }

  const result = await issueApprovalGrant(tenantId, {
    subjectDid: agent.did,
    capabilities: [`nova:${tenantId}:*`],
    expiryDays: opts.expiryDays ?? 30,
  });

  return { ...result, allowedSkills, trustTier };
}
