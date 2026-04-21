// packages/mcp-server/src/ucan-store.ts
//
// Sender-side credential store for the delegation-chain UCAN model.
//
// A sender agent holds exactly one long-lived credential: its approval grant
// (a UCAN issued by Nova at operator approval, with iss=novaDid aud=senderDid
// att=[tenant-scoped cap]). Per-task invocation tokens are minted on demand
// from the grant using the agent's Ed25519 private key — see ucan-mint.ts.
// Those tokens have 5-minute TTLs and aren't cached: there's no point; minting
// is cheap, and caching bearer tokens broadens the exfiltration window.
//
// Prior to the sender-signed refactor this store cached both a self-UCAN and
// a per-destination UCAN map. Both are gone — destination narrowing happens
// in the minted invocation token, so no cross-request state survives.

import fsp from 'fs/promises';
import path from 'path';
import lockfile from 'proper-lockfile';
import { NOVA_HOME } from './paths.js';

export interface StoredGrant {
  jwt: string;
  cid: string;
  expiresAt: string;
  /** Seconds-since-epoch fallback for lifetime calc when the JWT payload is not re-parsed. */
  issuedAt?: string;
}

export interface GrantCacheFile {
  agentId: string;
  grant?: StoredGrant;
}

function cachePath(agentId: string): string {
  return path.join(NOVA_HOME, 'agents', `${agentId}.ucan.json`);
}

export async function loadCache(agentId: string): Promise<GrantCacheFile> {
  try {
    return JSON.parse(await fsp.readFile(cachePath(agentId), 'utf8'));
  } catch (err: any) {
    if (err.code === 'ENOENT') return { agentId };
    throw err;
  }
}

export async function saveCache(cache: GrantCacheFile): Promise<void> {
  await fsp.mkdir(path.dirname(cachePath(cache.agentId)), { recursive: true, mode: 0o700 });
  const tmp = cachePath(cache.agentId) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, cachePath(cache.agentId));
}

/**
 * Serialise read-modify-write on one agent's grant cache across concurrent
 * MCP server instances. Two Claude Code sessions racing to claim the same
 * freshly-approved grant would otherwise (a) both hit /register/status with
 * only one receiving the one-time claim and (b) clobber each other's cache
 * on save.
 *
 * Uses proper-lockfile's atomic-mkdir strategy — portable across POSIX + NFS
 * (best-effort) + Windows. On lock acquisition, callers should re-read the
 * cache so the race loser picks up the winner's fresh grant instead of
 * another round-trip to admin-api.
 */
export async function withCacheLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const target = cachePath(agentId);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fsp.writeFile(target, JSON.stringify({ agentId }, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
  const release = await lockfile.lock(target, {
    retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
    stale: 10_000,
    realpath: false,
  });
  try { return await fn(); } finally { await release(); }
}

/** Remaining grant lifetime fraction in [0, 1]. Expired returns 0. */
export function remainingFraction(grant: StoredGrant): number {
  const expMs = new Date(grant.expiresAt).getTime();
  const now = Date.now();
  if (now >= expMs) return 0;
  const iat = parseIatFromJwt(grant.jwt) ?? (expMs - 30 * 24 * 3600 * 1000);
  const total = expMs - iat;
  return total <= 0 ? 0 : Math.max(0, (expMs - now) / total);
}

function parseIatFromJwt(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (typeof payload.iat === 'number') return payload.iat * 1000;
    if (typeof payload.nbf === 'number') return payload.nbf * 1000;
    return null;
  } catch { return null; }
}

/**
 * Returns the stored grant if present and still valid for at least the given
 * lifetime fraction, or null. No automatic renewal: grant refresh is an
 * operator-gated action (nova_reissue_ucan → /admin/.../ucans/reissue) so the
 * store only reports, it doesn't fetch.
 */
export async function getGrantIfFresh(
  agentId: string,
  minFraction = 0.05,
): Promise<StoredGrant | null> {
  const cache = await loadCache(agentId);
  if (!cache.grant) return null;
  if (remainingFraction(cache.grant) < minFraction) return null;
  return cache.grant;
}
