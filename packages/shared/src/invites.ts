import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from './tenant';
import { getSharedRedis } from './redis';

export interface InvitePayload {
  typ: 'invite';
  tenantId: string;
  agentIdHint?: string;
  exp: number;
  jti: string;
}

const CONSUMED_PREFIX = 'nova:invite-consumed:';

async function loadNovaPrivateKey(): Promise<crypto.KeyObject> {
  const keyPath = path.join(DATA_ROOT, 'keys', 'nova.private.pem');
  const pem = await fsp.readFile(keyPath, 'utf8').catch(() => {
    throw new Error('Nova keys not found — run scripts/generate-keys.ts first');
  });
  return crypto.createPrivateKey(pem);
}

async function loadNovaPublicKey(): Promise<crypto.KeyObject> {
  return crypto.createPublicKey(await loadNovaPrivateKey());
}

export async function createInvite(
  tenantId: string,
  data: { agentIdHint?: string | undefined; ttlSeconds: number; note?: string | undefined }
): Promise<{ token: string; jti: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + data.ttlSeconds;
  const jti = crypto.randomBytes(16).toString('base64url');

  const header = { alg: 'EdDSA', typ: 'JWT' };
  const payload: InvitePayload = {
    typ: 'invite',
    tenantId,
    ...(data.agentIdHint ? { agentIdHint: data.agentIdHint } : {}),
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
 * Verify an invite JWT and atomically mark it consumed.
 * Throws on invalid signature, expired token, or already-consumed jti.
 */
export async function verifyAndConsumeInvite(token: string): Promise<InvitePayload> {
  const parts = token.split('.');
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

  return payload;
}
