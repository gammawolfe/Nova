import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import bs58 from 'bs58';
import { AGENTS_DIR, agentIdentityPath } from './paths.js';
import { getKeyBackend } from './key-backend.js';

const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

export interface Identity {
  agentId: string;
  did: string;
  publicKey: string;      // base64 raw 32-byte Ed25519 public key
  privateKeyPem: string;  // PKCS8 PEM — stored via the active KeyBackend
  createdAt: string;
  // Which backend currently holds the private key on disk. Absent on the
  // legacy file-backend format; treated as 'file' for backwards compatibility.
  keyBackend?: 'file' | 'keychain';
}

export interface IdentityWithCreds extends Identity {
  ucan?: {
    jwt: string;
    expiresAt: string;
    trustTier?: number;
    ucanRenewalUrl?: string;
  };
  // H17 — Claim secret for grant pickup. Generated at registration time,
  // sent to the server only as a SHA-256 commitment. Persisted locally
  // alongside the private key (the file is already mode 0600). When the
  // active key backend is 'keychain', the secret rides in the on-disk JSON
  // — it is a 32-byte uniform random value with the same effective entropy
  // as the Ed25519 private scalar, but its compromise only enables a
  // one-time grant pickup race within the 24h claim window, not signing.
  // Treating it as ~equivalent to the keypair file is the simpler and
  // safer call than splitting it across stores.
  claimSecret?: string;
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

/**
 * Persist an identity via the active KeyBackend.
 *
 * File backend: identity JSON contains the PEM inline at file mode 0o600 —
 * identical to the pre-P2.8 layout, so existing agents survive untouched.
 *
 * Keychain backend: the PEM is written to the OS credential store via
 * getKeyBackend().storePrivateKey(); the on-disk JSON stores only metadata
 * plus `keyBackend:"keychain"` as a marker. The keychain write happens
 * BEFORE the JSON rewrite so a failed keychain call leaves the prior
 * identity intact rather than writing a dangling metadata record.
 */
export async function saveIdentity(identity: IdentityWithCreds): Promise<void> {
  await fsp.mkdir(AGENTS_DIR, { recursive: true, mode: 0o700 });
  const backend = getKeyBackend();
  const filePath = agentIdentityPath(identity.agentId);
  const tmp = filePath + '.tmp';

  if (backend.name === 'keychain') {
    await backend.storePrivateKey(identity.agentId, identity.privateKeyPem);
    const persisted: IdentityWithCreds = { ...identity, privateKeyPem: '', keyBackend: 'keychain' };
    await fsp.writeFile(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, filePath);
    return;
  }

  // File backend: keep inline PEM. Record keyBackend:'file' so we can detect
  // a later switch to keychain and migrate on read.
  const persisted: IdentityWithCreds = { ...identity, keyBackend: 'file' };
  await fsp.writeFile(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

/**
 * Load an identity, materialising the private key via the active KeyBackend.
 *
 * Handles three layouts on disk:
 *   1. Current file backend — JSON has inline PEM and keyBackend:"file" (or
 *      no keyBackend for pre-P2.8 records). Returned as-is.
 *   2. Current keychain backend — JSON has no PEM and keyBackend:"keychain".
 *      PEM fetched from the keychain and spliced in.
 *   3. Upgrade path (file → keychain) — JSON has inline PEM, but the current
 *      process has NOVA_KEY_BACKEND=keychain. The inline PEM is migrated
 *      into the keychain and removed from the JSON on this load.
 *
 * The migration path deliberately does NOT happen in reverse (keychain →
 * file auto-downgrade): reading secrets out of the keychain to write them
 * onto disk silently is a privilege-reduction the user probably didn't
 * intend. Explicit tooling can be added later if that use case appears.
 */
export async function loadIdentity(agentId: string): Promise<IdentityWithCreds | null> {
  let parsed: IdentityWithCreds;
  try {
    parsed = JSON.parse(await fsp.readFile(agentIdentityPath(agentId), 'utf8'));
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  const backend = getKeyBackend();
  const storedBackend = parsed.keyBackend ?? 'file';

  if (storedBackend === 'keychain') {
    const pem = await backend.loadPrivateKey(agentId);
    if (!pem) {
      throw new Error(
        `Identity '${agentId}' is marked as keychain-backed but no matching entry is stored. ` +
        `If NOVA_KEY_BACKEND was unset or the keychain was cleared, either restore the entry, ` +
        `regenerate the identity, or delete ${agentIdentityPath(agentId)} to start fresh.`,
      );
    }
    return { ...parsed, privateKeyPem: pem };
  }

  // storedBackend === 'file' — PEM is inline. If the current backend is
  // keychain, upgrade in place so subsequent loads are consistent.
  if (backend.name === 'keychain' && parsed.privateKeyPem) {
    await backend.storePrivateKey(agentId, parsed.privateKeyPem);
    const migrated: IdentityWithCreds = { ...parsed, privateKeyPem: '', keyBackend: 'keychain' };
    const tmp = agentIdentityPath(agentId) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(migrated, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, agentIdentityPath(agentId));
    return { ...migrated, privateKeyPem: parsed.privateKeyPem };
  }

  return parsed;
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
