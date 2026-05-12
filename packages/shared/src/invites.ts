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

/**
 * Load Nova's gateway Ed25519 private key from data/keys/nova.private.pem.
 *
 * Canonical format: PKCS8 PEM. Produced by scripts/generate-keys.ts and
 * accepted directly by Node's crypto.createPrivateKey.
 *
 * Backward-compat format: 64-byte libsodium secretKey (seed || pubkey),
 * base64-encoded — the output `ucans.EdKeypair.export()` produced. Older
 * installs created by the pre-PEM version of generate-keys.ts have files
 * in this form. They keep working transparently here; operators who want
 * to standardise on PEM can run scripts/migrate-keys.ts to convert in
 * place.
 *
 * The .pem filename refers to the canonical form. The legacy branch is
 * a compatibility shim, not a parallel format.
 */
export async function loadNovaPrivateKey(): Promise<crypto.KeyObject> {
  const keyPath = path.join(KEY_ROOT, 'nova.private.pem');
  const content = await fsp.readFile(keyPath, 'utf8').catch(() => {
    throw new Error('Nova keys not found — run scripts/generate-keys.ts first');
  });
  const trimmed = content.trim();

  // Canonical: PKCS8 PEM. Recognised by the BEGIN marker.
  if (trimmed.startsWith('-----BEGIN')) {
    return crypto.createPrivateKey(trimmed);
  }

  // Legacy: 64-byte libsodium secretKey, base64. Re-import via JWK so Node
  // crypto.sign() works alongside any remaining ucans usage in the calling
  // process. Operators on this path should run scripts/migrate-keys.ts to
  // switch to PEM; the dual-load path will be kept for at least one major
  // release after that migration is documented.
  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 64) {
    throw new Error(`Nova private key has unexpected length ${raw.length} (expected PKCS8 PEM, or 64-byte libsodium base64 for legacy installs)`);
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
 * Pure-parse path for an invite JWT — no signature verification, no Redis
 * touch, no server-only dependencies. Used by:
 *
 *   • `verifyInvite` below — layers signature verification on top.
 *   • `tenant-config.ts:decodeInvitePayload` — the client-side decoder
 *     that displays invite details before joining a tenant.
 *
 * Both consumers previously hand-rolled their own copy of this logic and
 * drifted on details like whitespace handling, expired-tolerance, and which
 * fields are required. Consolidating means a bug fix in one place fixes
 * the other automatically.
 *
 * Throws plain Error on any structural / claim / expiry failure. The
 * `verifyInvite` caller decorates the throws with HTTP status codes
 * downstream; callers that only need the parse path (CLI inspect, MCP
 * decode) get plain errors with no server-shaped status field.
 *
 * Whitespace is stripped before parsing — JWTs pasted through terminals
 * can arrive with embedded newlines from line-wrapping. Stripping up
 * front makes the parse + signature paths agree byte-for-byte.
 */
export interface ParseInvitePayloadOptions {
  /** If true, expired tokens parse successfully and return `expired: true`. */
  allowExpired?: boolean;
}

export interface ParsedInvitePayload extends InvitePayload {
  /** Only set when allowExpired === true and the token is past its exp. */
  expired?: boolean;
  /** Raw parts of the JWT — useful to callers (verifyInvite) that need to
   *  verify the signature against the original preimage. */
  parts: { headerB64: string; payloadB64: string; signatureB64: string };
}

export function parseInviteJwtPayload(
  token: string,
  opts: ParseInvitePayloadOptions = {},
): ParsedInvitePayload {
  const normalized = token.replace(/\s+/g, '');
  const parts = normalized.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed invite token');
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let payload: InvitePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invite payload malformed');
  }

  if (payload.typ !== 'invite') {
    throw new Error('Not an invite token');
  }
  if (!payload.tenantId || !payload.jti || typeof payload.exp !== 'number') {
    throw new Error('Invite missing required claims');
  }

  const expired = payload.exp < Math.floor(Date.now() / 1000);
  if (expired && !opts.allowExpired) {
    throw new Error('Invite expired');
  }

  const result: ParsedInvitePayload = {
    ...payload,
    parts: { headerB64, payloadB64, signatureB64 },
  };
  if (expired) result.expired = true;
  return result;
}

/**
 * Verify an invite JWT's signature, structure, and expiry. Does NOT consume.
 *
 * Throws on malformed token, invalid signature, wrong typ, missing claims, or
 * expired token. The returned payload is safe to use for downstream validation
 * (agentIdHint match, tenant existence, duplicate-agent checks) before the
 * caller decides to consume. See `consumeInvite`.
 *
 * Errors are decorated with an HTTP `status` field so the route layer can
 * map them to a response code without needing a switch statement on the
 * error message. Structural failures inherit status 400 from this wrapper.
 */
export async function verifyInvite(token: string): Promise<InvitePayload> {
  let parsed: ParsedInvitePayload;
  try {
    parsed = parseInviteJwtPayload(token);
  } catch (err: any) {
    const msg: string = err.message ?? '';
    if (msg.includes('expired')) {
      throw Object.assign(err, { status: 410 });
    }
    throw Object.assign(err, { status: 400 });
  }

  const { headerB64, payloadB64, signatureB64 } = parsed.parts;
  const publicKey = await loadNovaPublicKey();
  const valid = crypto.verify(
    null,
    Buffer.from(`${headerB64}.${payloadB64}`),
    publicKey,
    Buffer.from(signatureB64, 'base64url'),
  );
  if (!valid) throw Object.assign(new Error('Invite signature invalid'), { status: 401 });

  // Strip the `parts` helper from the returned payload — callers don't need
  // it once verification has passed.
  const { parts: _parts, expired: _expired, ...payload } = parsed;
  return payload as InvitePayload;
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
