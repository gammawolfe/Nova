import fsp from 'fs/promises';
import path from 'path';
import lockfile from 'proper-lockfile';
import { NOVA_HOME } from './paths.js';
import { NovaClient } from './nova-client.js';
import { sign } from './identity.js';

export interface StoredUcan {
  jwt: string;
  cid: string;
  expiresAt: string;
  ucanRenewalUrl?: string;
}

export interface UcanCacheFile {
  agentId: string;
  self?: StoredUcan;                                      // UCAN issued at approval (own-namespace scope)
  perDestination?: Record<string, StoredUcan>;           // key = `${destTenantId}/${destAgentId}`
}

function cachePath(agentId: string): string {
  return path.join(NOVA_HOME, 'agents', `${agentId}.ucan.json`);
}

export async function loadCache(agentId: string): Promise<UcanCacheFile> {
  try {
    return JSON.parse(await fsp.readFile(cachePath(agentId), 'utf8'));
  } catch (err: any) {
    if (err.code === 'ENOENT') return { agentId };
    throw err;
  }
}

export async function saveCache(cache: UcanCacheFile): Promise<void> {
  await fsp.mkdir(path.dirname(cachePath(cache.agentId)), { recursive: true, mode: 0o700 });
  const tmp = cachePath(cache.agentId) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, cachePath(cache.agentId));
}

/**
 * Serialise all read-modify-write operations on one agent's UCAN cache across
 * concurrent MCP server instances. Two Claude Code sessions racing to renew
 * the same agent's UCAN would otherwise (a) both hit admin-api with nonce
 * roundtrips that only one can win and (b) clobber each other's perDestination
 * map on save.
 *
 * Uses proper-lockfile's atomic-mkdir strategy — portable across POSIX + NFS
 * (best-effort) + Windows. On lock acquisition, callers should re-read the
 * cache so the race loser picks up the winner's fresh UCAN instead of doing
 * another renewal.
 */
export async function withCacheLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const target = cachePath(agentId);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  // proper-lockfile needs an existing file to lock against. Create a sentinel
  // if the cache hasn't been written yet — this is atomic via O_EXCL and
  // tolerates the "racer beat us to it" case.
  try {
    await fsp.writeFile(target, JSON.stringify({ agentId }, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
  const release = await lockfile.lock(target, {
    retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,           // take over orphaned locks after 10s of silence
    realpath: false,         // don't follow symlinks; lock the exact path
  });
  try { return await fn(); } finally { await release(); }
}

/** Remaining lifetime fraction [0, 1]. Expired returns 0. */
export function remainingFraction(ucan: StoredUcan, issuedAt?: string): number {
  const expMs = new Date(ucan.expiresAt).getTime();
  const now = Date.now();
  if (now >= expMs) return 0;
  // Without a known issuedAt, approximate total lifetime from the UCAN's inner iat claim if parseable
  const iat = issuedAt ? new Date(issuedAt).getTime() : parseIatFromJwt(ucan.jwt) ?? (expMs - 30 * 24 * 3600 * 1000);
  const total = expMs - iat;
  return total <= 0 ? 0 : Math.max(0, (expMs - now) / total);
}

function parseIatFromJwt(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    // UCAN spec uses `nbf` (not-before) or `iat`; fall back to attempting either
    if (typeof payload.iat === 'number') return payload.iat * 1000;
    if (typeof payload.nbf === 'number') return payload.nbf * 1000;
    return null;
  } catch { return null; }
}

/**
 * Renew the self-UCAN via proof-of-possession if it's below the refresh threshold.
 * Returns the current (possibly just-refreshed) JWT.
 *
 * Serialised under withCacheLock. On the slow path, the cache is re-read after
 * acquiring the lock so that if a concurrent instance renewed in the meantime,
 * we reuse its fresh UCAN instead of making a redundant nonce roundtrip.
 */
export async function ensureSelfUcan(
  client: NovaClient,
  tenantId: string,
  agentId: string,
  did: string,
  privateKeyPem: string,
  refreshThreshold = 0.2,
): Promise<string> {
  // Fast path: no lock needed if cache is already fresh.
  const quick = await loadCache(agentId);
  if (quick.self && remainingFraction(quick.self) >= refreshThreshold) {
    return quick.self.jwt;
  }

  return withCacheLock(agentId, async () => {
    // Re-read inside the lock — a peer may have just renewed.
    const cache = await loadCache(agentId);
    if (cache.self && remainingFraction(cache.self) >= refreshThreshold) {
      return cache.self.jwt;
    }

    const { nonce } = await client.renewNonce(tenantId, did, agentId);
    const signature = sign(privateKeyPem, nonce);
    const result = await client.renewSubmit(tenantId, { did, agentId, nonce, signature });

    cache.self = { jwt: result.jwt, cid: result.cid, expiresAt: result.expiresAt };
    await saveCache(cache);
    return result.jwt;
  });
}

/**
 * Obtain a UCAN scoped to a specific destination. Fetches from cache if fresh;
 * otherwise performs the proof-of-possession request against admin-api.
 *
 * Serialised under withCacheLock — see ensureSelfUcan for the race it prevents.
 */
export async function ensureDestinationUcan(
  client: NovaClient,
  sourceTenantId: string,
  sourceAgentId: string,
  did: string,
  privateKeyPem: string,
  destination: { tenantId: string; agentId: string; skills: string[] },
  refreshThreshold = 0.2,
): Promise<string> {
  const key = `${destination.tenantId}/${destination.agentId}`;

  // Fast path: avoid the lock if we already have a fresh destination UCAN.
  const quick = await loadCache(sourceAgentId);
  const quickExisting = quick.perDestination?.[key];
  if (quickExisting && remainingFraction(quickExisting) >= refreshThreshold) {
    return quickExisting.jwt;
  }

  return withCacheLock(sourceAgentId, async () => {
    const cache = await loadCache(sourceAgentId);
    const existing = cache.perDestination?.[key];
    if (existing && remainingFraction(existing) >= refreshThreshold) {
      return existing.jwt;
    }

    const { nonce } = await client.renewNonce(sourceTenantId, did, sourceAgentId);
    const signature = sign(privateKeyPem, nonce);
    const result = await client.requestUcan(sourceTenantId, {
      did,
      agentId: sourceAgentId,
      nonce,
      signature,
      destTenantId: destination.tenantId,
      destAgentId: destination.agentId,
      skills: destination.skills,
    });

    cache.perDestination = { ...(cache.perDestination ?? {}), [key]: {
      jwt: result.jwt,
      cid: result.cid,
      expiresAt: result.expiresAt,
    } };
    await saveCache(cache);
    return result.jwt;
  });
}
