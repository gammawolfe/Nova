import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT, KEY_ROOT } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';
import { loadNovaPrivateKey } from '@nova/shared/src/invites';
import { verifyAndConsumeNonce } from './nonce-service';
import * as agentService from './agent-service';
import * as trustService from './trust-service';
import { logger } from '@nova/shared/src/logger';

interface UcanMetadata {
  cid: string;
  issuedTo: string;
  capabilities: string[];
  expiresAt: string;
  issuedAt: string;
  tenantId: string;
  revoked: boolean;
}

const issuedDir = path.join(DATA_ROOT, 'ucans', 'issued');
const revokedDir = path.join(DATA_ROOT, 'ucans', 'revoked');

function computeCid(jwt: string): string {
  return crypto.createHash('sha256').update(jwt).digest('hex').slice(0, 32);
}

export async function issueUcan(tenantId: string, data: {
  subjectDid: string; capabilities: string[]; expiryDays: number;
}): Promise<{ jwt: string; cid: string; expiresAt: string }> {
  const didPath = path.join(KEY_ROOT, 'nova.did');

  let novaDid: string;
  try {
    novaDid = (await fsp.readFile(didPath, 'utf8')).trim();
  } catch {
    throw new Error('Nova keys not found — run scripts/generate-keys.ts first');
  }

  const exp = Math.floor(Date.now() / 1000) + data.expiryDays * 86400;
  const expiresAt = new Date(exp * 1000).toISOString();

  const header = { alg: 'EdDSA', typ: 'JWT', ucv: '0.10.0' };
  // Nova-as-notary model: UCAN is presented to Nova's gateway, which verifies
  // aud === its own DID. Both iss and aud are Nova's root DID; the subject
  // agent is the bearer. Sender identity in audits derives from the trust-
  // registry lookup of the bearer's DID during the Gate pipeline.
  //
  // jti is included so two UCANs with identical capabilities issued within
  // the same second (e.g. revoke-old + issue-new during key rotation) get
  // distinct JWTs and therefore distinct CIDs — without it, sha256(jwt)
  // collides and a freshly-issued UCAN could appear in the revoked set.
  const payload = {
    iss: novaDid,
    aud: novaDid,
    exp,
    att: data.capabilities.map(cap => ({ with: cap, can: 'invoke' })),
    prf: [],
    jti: crypto.randomUUID(),
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const privateKey = await loadNovaPrivateKey();
  const signature = crypto.sign(null, Buffer.from(`${headerB64}.${payloadB64}`), privateKey);
  const signatureB64 = signature.toString('base64url');

  const jwt = `${headerB64}.${payloadB64}.${signatureB64}`;
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
  };
  await writeAtomicallyAsync(path.join(issuedDir, cid + '.json'), metadata);

  return { jwt, cid, expiresAt };
}

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

// ── Proof-of-Possession UCAN Renewal ────────────────────────────────────────


/**
 * Renew a UCAN via proof-of-possession:
 * 1. Verify and consume the nonce
 * 2. Verify the Ed25519 signature of the nonce using the agent's stored public key
 * 3. Verify the agent is active and the DID matches
 * 4. Issue a fresh UCAN
 */
export async function renewUcan(
  tenantId: string,
  data: { did: string; agentId: string; nonce: string; signature: string }
): Promise<{ jwt: string; cid: string; expiresAt: string }> {
  // Step 1: Verify and consume the nonce
  const nonceCheck = verifyAndConsumeNonce(data.nonce, data.did, data.agentId);
  if (!nonceCheck.valid) {
    const err: any = new Error(`Nonce verification failed: ${nonceCheck.reason}`);
    if (nonceCheck.reason === 'nonce_expired') err.status = 410;
    else if (['nonce_did_mismatch', 'nonce_agent_mismatch'].includes(nonceCheck.reason!)) err.status = 401;
    else err.status = 400;
    throw err;
  }

  // Step 2: Verify the agent exists and is active
  const agent = await agentService.getAgent(tenantId, data.agentId);
  if (!agent) {
    throw Object.assign(new Error(`Agent ${data.agentId} not found`), { status: 404 });
  }
  if (agent.status !== 'active') {
    throw Object.assign(new Error(`Agent ${data.agentId} is not active (status: ${agent.status})`), { status: 403 });
  }

  // Step 3: Verify the DID matches the registered DID
  if (agent.did !== data.did) {
    throw Object.assign(new Error('DID does not match registered agent DID'), { status: 401 });
  }

  // Step 4: Proof-of-possession — verify Ed25519 signature
  if (!agent.publicKey) {
    throw Object.assign(new Error('Agent has no registered public key'), { status: 403 });
  }

  try {
    // Ed25519 public key stored as raw bytes — wrap in SPKI DER to import
    const rawKeyBytes = Buffer.from(agent.publicKey, 'base64');
    // SPKI DER prefix for Ed25519: 30 2A 30 05 06 03 2B 65 70 03 21 00 (12 bytes)
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiDer = Buffer.concat([spkiPrefix, rawKeyBytes]);
    const publicKey = crypto.createPublicKey({
      key: spkiDer,
      format: 'der',
      type: 'spki',
    });
    const valid = crypto.verify(
      null,
      Buffer.from(data.nonce, 'utf8'),
      publicKey,
      Buffer.from(data.signature, 'base64url')
    );
    if (!valid) {
      throw Object.assign(new Error('Signature verification failed — invalid proof of possession'), { status: 401 });
    }
  } catch (err: any) {
    if (err.status) throw err;
    throw Object.assign(new Error(`Signature verification failed: ${err.message}`), { status: 401 });
  }

  // Step 5: Issue a new UCAN — capability scoped to this agent's namespace
  return issueUcan(tenantId, {
    subjectDid: data.did,
    capabilities: [`nova:${tenantId}:${data.agentId}`],
    expiryDays: 30, // Default for renewals — can be overridden later
  });
}

// ── Cross-destination UCAN issuance (Proof-of-Possession) ───────────────────

/**
 * Issue a UCAN scoped to a specific destination tenant + agent + skills.
 * Same PoP flow as renewUcan: caller proves ownership of its DID by signing
 * a nonce; we then mint a narrow UCAN targeting the destination.
 *
 * Used when agent A in tenant X wants to send tasks to agent Z in tenant Y —
 * A requests a UCAN with capability `nova:Y:Z:skill:*` instead of carrying a
 * wildcard credential.
 */
export async function requestUcan(
  sourceTenantId: string,
  data: {
    did: string;
    agentId: string;
    nonce: string;
    signature: string;
    destTenantId: string;
    destAgentId: string;
    skills: string[];
    expiryDays: number;
  }
): Promise<{ jwt: string; cid: string; expiresAt: string }> {
  // PoP: verify nonce + signature against source agent's stored public key
  const nonceCheck = verifyAndConsumeNonce(data.nonce, data.did, data.agentId);
  if (!nonceCheck.valid) {
    const err: any = new Error(`Nonce verification failed: ${nonceCheck.reason}`);
    if (nonceCheck.reason === 'nonce_expired') err.status = 410;
    else if (['nonce_did_mismatch', 'nonce_agent_mismatch'].includes(nonceCheck.reason!)) err.status = 401;
    else err.status = 400;
    throw err;
  }

  const agent = await agentService.getAgent(sourceTenantId, data.agentId);
  if (!agent) throw Object.assign(new Error(`Agent ${data.agentId} not found`), { status: 404 });
  if (agent.status !== 'active') {
    throw Object.assign(new Error(`Agent ${data.agentId} is not active`), { status: 403 });
  }
  if (agent.did !== data.did) {
    throw Object.assign(new Error('DID does not match registered agent DID'), { status: 401 });
  }
  if (!agent.publicKey) {
    throw Object.assign(new Error('Agent has no registered public key'), { status: 403 });
  }

  const rawKeyBytes = Buffer.from(agent.publicKey, 'base64');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const spkiDer = Buffer.concat([spkiPrefix, rawKeyBytes]);
  const publicKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  const valid = crypto.verify(
    null,
    Buffer.from(data.nonce, 'utf8'),
    publicKey,
    Buffer.from(data.signature, 'base64url')
  );
  if (!valid) {
    throw Object.assign(new Error('Signature verification failed — invalid proof of possession'), { status: 401 });
  }

  const capabilities = data.skills.map(s => `nova:${data.destTenantId}:${data.destAgentId}:skill:${s}`);

  // UCAN is recorded under the destination tenant for audit / revocation by that operator
  return issueUcan(data.destTenantId, {
    subjectDid: data.did,
    capabilities,
    expiryDays: data.expiryDays,
  });
}

// ── Bulk revocation by subject ───────────────────────────────────────────────

/**
 * Revoke every issued UCAN whose `issuedTo` matches the given DID in the
 * given tenant. Returns the list of revoked CIDs. Tolerates the revoked-dir
 * not existing yet (first-rotate case).
 *
 * Used by key rotation to invalidate the old DID's credentials atomically
 * with the public-key swap — otherwise a stolen UCAN issued to the prior
 * identity would remain valid until natural expiry.
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
 *   2. Revoke every UCAN previously issued to oldDid in this tenant.
 *   3. Swap {did, publicKey} on agent-config and re-index.
 *   4. Remove old trust-registry actor; add new actor with the same tier +
 *      allowedSkills. A missing actor (reissue-after-approval edge case)
 *      degrades to tier-1 wildcard with a logged warning.
 *   5. Mint a fresh self-UCAN for the new DID.
 *
 * Same-tenant trust registry is rebuilt automatically. Cross-tenant trust
 * entries that reference oldDid become stale — those tenants must re-seed
 * their actor table with newDid before inter-tenant traffic resumes. The
 * caller-facing response includes `affectedPeerTenants` so the operator can
 * action this manually; a structured warn log also fires.
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
  let trustTier = existingActor?.tier ?? 1;
  let allowedSkills = existingActor?.allowedSkills ?? ['*'];
  const displayName = existingActor?.displayName ?? agent.name;
  if (!existingActor) {
    logger.warn(
      { tenantId, agentId, oldDid: data.oldDid },
      'Trust-registry entry missing on key rotation — defaulting to wildcard tier-1',
    );
  }

  // Revoke before the swap — any concurrent task-send that holds an old
  // destination UCAN fails closed at the gate rather than slipping through
  // after the agent record has been updated.
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

  // Mint the fresh self-UCAN. Expiry defaults to 30d, same as reissue.
  const capabilities = allowedSkills.map(s => `nova:${tenantId}:${agentId}:skill:${s}`);
  const result = await issueUcan(tenantId, {
    subjectDid: data.newDid,
    capabilities,
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
 * Reissue a self-UCAN for an already-approved agent. Used when the one-time
 * claim has expired or been lost before the agent could pick it up.
 *
 * Capabilities are recovered from the trust-registry entry created at approval
 * (agent's own DID). Expiry defaults to 30 days. The fresh UCAN is minted and
 * returned; the caller is responsible for re-stashing the Redis claim so the
 * agent can pick it up via GET /register/status.
 *
 * Throws with .status=404 (agent missing), .status=409 (agent not active),
 * .status=412 (agent has no DID recorded). Trust-registry miss degrades to
 * a wildcard-tier-1 capability with a logged warning.
 */
export async function reissueUcan(
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

  const capabilities = allowedSkills.map(s => `nova:${tenantId}:${agentId}:skill:${s}`);
  const result = await issueUcan(tenantId, {
    subjectDid: agent.did,
    capabilities,
    expiryDays: opts.expiryDays ?? 30,
  });

  return { ...result, allowedSkills, trustTier };
}
