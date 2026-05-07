// packages/shared/src/claim-secret.ts
//
// H17 — Grant-pickup auth hardening.
//
// Helpers for the claim-secret/commitment scheme that gates GET /register/status.
// The agent generates a random secret at registration, sends only its hash
// (the "commitment") in POST /register, and retains the secret locally. On
// status poll after approval, the agent presents the secret in a header; the
// server hashes it and compares to the stored commitment.
//
// Properties:
//   • Secret is 32 bytes / 256 bits of CSPRNG → 2^256 keyspace, brute-force
//     infeasible inside the 24h claim window.
//   • Commitment is SHA-256, 64 hex chars. The server never holds the secret
//     in cleartext at rest.
//   • Constant-time comparison closes a class of timing oracles even though
//     the threat model here (an attacker on the same network as the agent)
//     makes that improbable.
//   • A small failed-attempt counter (3 strikes) deletes the claim entry,
//     forcing the operator to nova_reissue_ucan. That bounds the cost of a
//     compromised tenantId/agentId leak even if the secret leaked too.
//
// Threat model:
//   The status endpoint is unauthenticated (no UCAN, no admin token), so the
//   secret is the only credential. An attacker who knows the tenantId and
//   agentId (e.g. from a leaked log line) but not the secret cannot claim
//   the grant. An attacker who additionally has the secret (e.g. by
//   compromising the agent's local keystore) is already past the gate this
//   protects — the secret lives next to the Ed25519 private key.

import crypto from 'crypto';

const SECRET_BYTES = 32;
export const COMMITMENT_HEX_LEN = 64;
export const CLAIM_SECRET_HEADER = 'x-claim-secret';
export const MAX_FAILED_ATTEMPTS = 3;

/**
 * Generate a fresh 32-byte claim secret. Returns the secret as a base64url
 * string suitable for inclusion in a header, alongside its commitment hex.
 *
 * Callers should persist the secret locally (mode 0600) and send only the
 * commitment to the server.
 */
export function generateClaimSecret(): { secret: string; commitment: string } {
  const raw = crypto.randomBytes(SECRET_BYTES);
  const secret = raw.toString('base64url');
  const commitment = commitmentOf(secret);
  return { secret, commitment };
}

/**
 * Compute the SHA-256 commitment of a secret. Idempotent: same input →
 * same output. Used by both the client (at generation time) and the
 * server (at verification time).
 */
export function commitmentOf(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex commitments. Both inputs MUST be the
 * same length; mismatched-length inputs are rejected without comparison so
 * an attacker can't measure length probing.
 */
export function commitmentEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  if (a.length !== COMMITMENT_HEX_LEN) return false;
  // timingSafeEqual on equal-length Buffers
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Validate the shape of a commitment string (64 lowercase hex). Useful for
 * rejecting malformed input at the API edge before any storage write.
 */
export function isValidCommitment(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
