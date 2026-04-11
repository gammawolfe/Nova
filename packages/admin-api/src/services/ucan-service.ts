import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';

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
