import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';
import { verifyAndConsumeNonce } from './nonce-service';
import * as agentService from './agent-service';

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
  const keyPath = path.join(DATA_ROOT, 'keys', 'nova.private.pem');
  const didPath = path.join(DATA_ROOT, 'keys', 'nova.did');

  let novaDid: string;
  let privateKeyPem: string;
  try {
    [novaDid, privateKeyPem] = await Promise.all([
      fsp.readFile(didPath, 'utf8').then(s => s.trim()),
      fsp.readFile(keyPath, 'utf8'),
    ]);
  } catch {
    throw new Error('Nova keys not found — run scripts/generate-keys.ts first');
  }

  const exp = Math.floor(Date.now() / 1000) + data.expiryDays * 86400;
  const expiresAt = new Date(exp * 1000).toISOString();

  const header = { alg: 'EdDSA', typ: 'JWT', ucv: '0.10.0' };
  const payload = {
    iss: novaDid,
    aud: data.subjectDid,
    exp,
    att: data.capabilities.map(cap => ({ with: cap, can: 'invoke' })),
    prf: [],
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  const privateKey = crypto.createPrivateKey(privateKeyPem);
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
