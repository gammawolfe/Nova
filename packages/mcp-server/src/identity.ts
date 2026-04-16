import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import bs58 from 'bs58';
import { AGENTS_DIR, agentIdentityPath } from './paths.js';

const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

export interface Identity {
  agentId: string;
  did: string;
  publicKey: string;      // base64 raw 32-byte Ed25519 public key
  privateKeyPem: string;  // PKCS8 PEM — stored at file mode 0600
  createdAt: string;
}

export interface IdentityWithCreds extends Identity {
  ucan?: {
    jwt: string;
    expiresAt: string;
    trustTier?: number;
    ucanRenewalUrl?: string;
  };
}

function encodeDidKey(rawPublicKey: Buffer): string {
  const prefixed = Buffer.concat([ED25519_MULTICODEC_PREFIX, rawPublicKey]);
  return `did:key:z${bs58.encode(prefixed)}`;
}

function rawPublicKeyFromKeyObject(pub: crypto.KeyObject): Buffer {
  const jwk = pub.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('Public key missing x coordinate');
  return Buffer.from(jwk.x, 'base64url');
}

export function generateIdentity(agentId: string): Identity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = rawPublicKeyFromKeyObject(publicKey);
  return {
    agentId,
    did: encodeDidKey(rawPub),
    publicKey: rawPub.toString('base64'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    createdAt: new Date().toISOString(),
  };
}

export async function saveIdentity(identity: IdentityWithCreds): Promise<void> {
  await fsp.mkdir(AGENTS_DIR, { recursive: true, mode: 0o700 });
  const filePath = agentIdentityPath(identity.agentId);
  const tmp = filePath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

export async function loadIdentity(agentId: string): Promise<IdentityWithCreds | null> {
  try {
    const raw = await fsp.readFile(agentIdentityPath(agentId), 'utf8');
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function listAgentIds(): Promise<string[]> {
  try {
    const files = await fsp.readdir(AGENTS_DIR);
    return files.filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'));
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Sign arbitrary bytes with the agent's private Ed25519 key. */
export function sign(privateKeyPem: string, message: Buffer | string): string {
  const pk = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, typeof message === 'string' ? Buffer.from(message, 'utf8') : message, pk);
  return sig.toString('base64url');
}
