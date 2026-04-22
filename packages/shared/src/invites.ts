import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT, KEY_ROOT } from './tenant';
import { getSharedRedis } from './redis';

export interface InvitePayload {
  typ: 'invite';
  tenantId: string;
  agentIdHint?: string;
  exp: number;
  jti: string;
}

const CONSUMED_PREFIX = 'nova:invite-consumed:';

export async function loadNovaPrivateKey(): Promise<crypto.KeyObject> {
  const keyPath = path.join(KEY_ROOT, 'nova.private.pem');
  const content = await fsp.readFile(keyPath, 'utf8').catch(() => {
    throw new Error('Nova keys not found — run scripts/generate-keys.ts first');
  });
  const trimmed = content.trim();

  // PEM — use directly.
  if (trimmed.startsWith('-----BEGIN')) {
    return crypto.createPrivateKey(trimmed);
  }

  // ucans EdKeypair.export() — 64-byte libsodium secretKey (seed || pubkey), base64.
  // Re-import via JWK so Node crypto.sign() works alongside ucans's own usage.
  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 64) {
    throw new Error(`Nova private key has unexpected length ${raw.length} (expected PEM or 64-byte ucans base64)`);
  }
  const seed = raw.subarray(0, 32);
  const pub = raw.subarray(32, 64);
  return crypto.createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      d: seed.toString('base64url'),
      x: pub.toString('base64url'),
    },
    format: 'jwk',
  });
}

async function loadNovaPublicKey(): Promise<crypto.KeyObject> {
  return crypto.createPublicKey(await loadNovaPrivateKey());
}

/**
 * Load Nova's gateway DID from data/keys/nova.did. Returns null if the file
 * doesn't exist (fresh install before generate-keys). Trims whitespace.
 */
export async function loadNovaDid(): Promise<string | null> {
  const didPath = path.join(KEY_ROOT, 'nova.did');
  try {
    return (await fsp.readFile(didPath, 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function createInvite(
  tenantId: string,
  data: { agentIdHint: string; ttlSeconds: number; note?: string | undefined }
): Promise<{ token: string; jti: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + data.ttlSeconds;
  const jti = crypto.randomBytes(16).toString('base64url');

  const header = { alg: 'EdDSA', typ: 'JWT' };
  const payload: InvitePayload = {
    typ: 'invite',
    tenantId,
    agentIdHint: data.agentIdHint,
    exp,
    jti,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const privateKey = await loadNovaPrivateKey();
  const signature = crypto
    .sign(null, Buffer.from(`${headerB64}.${payloadB64}`), privateKey)
    .toString('base64url');

  return {
    token: `${headerB64}.${payloadB64}.${signature}`,
    jti,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Verify an invite JWT's signature, structure, and expiry. Does NOT consume.
 *
 * Throws on malformed token, invalid signature, wrong typ, missing claims, or
 * expired token. The returned payload is safe to use for downstream validation
 * (agentIdHint match, tenant existence, duplicate-agent checks) before the
 * caller decides to consume. See `consumeInvite`.
 *
 * Whitespace is stripped before parsing — JWTs pasted through terminals can
 * arrive with embedded newlines from line-wrapping. Base64url decoding
 * tolerates whitespace silently, but crypto.verify signs the raw preimage
 * byte-for-byte, so embedded newlines would flip an otherwise-valid signature
 * to failure. Stripping up front makes the two paths agree.
 */
export async function verifyInvite(token: string): Promise<InvitePayload> {
  const normalized = token.replace(/\s+/g, '');
  const parts = normalized.split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('Malformed invite token'), { status: 400 });
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const publicKey = await loadNovaPublicKey();
  const valid = crypto.verify(
    null,
    Buffer.from(`${headerB64}.${payloadB64}`),
    publicKey,
    Buffer.from(signatureB64!, 'base64url')
  );
  if (!valid) throw Object.assign(new Error('Invite signature invalid'), { status: 401 });

  let payload: InvitePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invite payload malformed'), { status: 400 });
  }

  if (payload.typ !== 'invite') {
    throw Object.assign(new Error('Not an invite token'), { status: 400 });
  }
  if (!payload.tenantId || !payload.jti || typeof payload.exp !== 'number') {
    throw Object.assign(new Error('Invite missing required claims'), { status: 400 });
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error('Invite expired'), { status: 410 });
  }

  return payload;
}

/**
 * Atomically mark an invite jti as consumed. Call this only after all other
 * validation has passed — consumption is one-shot and irreversible within the
 * TTL window.
 *
 * Throws with status 409 if the jti has already been consumed.
 */
export async function consumeInvite(payload: InvitePayload): Promise<void> {
  const redis = getSharedRedis();
  const remainingSec = Math.max(60, payload.exp - Math.floor(Date.now() / 1000));
  const reserved = await redis.set(
    `${CONSUMED_PREFIX}${payload.jti}`,
    '1',
    'EX',
    remainingSec,
    'NX'
  );
  if (reserved !== 'OK') {
    throw Object.assign(new Error('Invite already consumed'), { status: 409 });
  }
}

/**
 * Verify an invite JWT and atomically mark it consumed in a single step.
 *
 * Prefer `verifyInvite` + `consumeInvite` in flows where downstream validation
 * can fail after verify but before consume (e.g. the self-registration route),
 * so that failures don't burn the invite.
 */
export async function verifyAndConsumeInvite(token: string): Promise<InvitePayload> {
  const payload = await verifyInvite(token);
  await consumeInvite(payload);
  return payload;
}
