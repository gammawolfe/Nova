import crypto from 'crypto';
import { logger } from '@nova/shared/src/logger';

interface NonceRecord {
  nonce: string;
  did: string;
  agentId: string;
  createdAt: number;
  expiresAt: number;
}

// In-memory nonce store
const nonces = new Map<string, NonceRecord>();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a cryptographically random nonce for proof-of-possession.
 */
export function createNonce(did: string, agentId: string): { nonce: string; expiresAt: string } {
  const nonce = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  nonces.set(nonce, {
    nonce,
    did,
    agentId,
    createdAt: now,
    expiresAt: now + NONCE_TTL_MS,
  });

  logger.info({ did, agentId, nonce: nonce.slice(0, 8) + '...' }, 'Nonce created for UCAN renewal');
  return { nonce, expiresAt: new Date(now + NONCE_TTL_MS).toISOString() };
}

/**
 * Verify a nonce exists, hasn't expired, and matches the expected DID/agentId.
 * Nonce is consumed (deleted) on successful verification — one-time use.
 */
export function verifyAndConsumeNonce(
  nonce: string,
  did: string,
  agentId: string
): { valid: boolean; reason?: string } {
  const record = nonces.get(nonce);

  if (!record) {
    return { valid: false, reason: 'nonce_not_found' };
  }

  if (Date.now() > record.expiresAt) {
    nonces.delete(nonce);
    return { valid: false, reason: 'nonce_expired' };
  }

  if (record.did !== did) {
    return { valid: false, reason: 'nonce_did_mismatch' };
  }

  if (record.agentId !== agentId) {
    return { valid: false, reason: 'nonce_agent_mismatch' };
  }

  // Consume the nonce — one-time use only
  nonces.delete(nonce);
  logger.info({ did, agentId }, 'Nonce verified and consumed');
  return { valid: true };
}

/**
 * Clean up expired nonces (call periodically or on low-traffic).
 */
export function purgeExpiredNonces(): number {
  let purged = 0;
  const now = Date.now();
  for (const [nonce, record] of nonces) {
    if (now > record.expiresAt) {
      nonces.delete(nonce);
      purged++;
    }
  }
  return purged;
}
