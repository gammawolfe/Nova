// packages/shared/src/ucan-mint.ts
//
// Mint an invocation token on the sender side. Produces a UCAN JWT:
//
//   iss: sender DID (did:key derived from the local identity)
//   aud: Nova gateway DID (fetched from the tenant config)
//   att: [{ with: destination scope, can: "invoke" }]
//   prf: [grantJwt]  — the approval grant issued by Nova at operator approval
//   exp: now + ttlSeconds (5 min default)
//
// The private key that signs the outer JWT is the sender's own Ed25519 key,
// loaded from ~/.nova/agents/<agentId>.json via identity.ts. The gate verifies
// the outer signature against the pubkey derived from iss (standard did:key),
// then walks prf to re-verify the grant against Nova's pubkey and confirm the
// chain's audience/subsumption properties — all in packages/gate-service.

import crypto from 'crypto';
import { buildUcanJwt, parseUcanJwt, UcanPayload, UcanCapability } from './ucan.js';

export interface MintOpts {
  senderDid: string;
  senderPrivateKeyPem: string;
  grantJwt: string;           // Nova-signed approval grant (used as prf root)
  scope: string;              // e.g. "nova:tenant_X:agent_Y:skill:chat"
  ttlSeconds?: number;        // default 300 (5 min)
}

/**
 * Mint an invocation token for a single task submission.
 *
 * The grant's `iss` IS Nova's gateway DID, so we read it from the grant
 * instead of asking the sender to configure it separately — the credential
 * carries the gateway identity it authorizes against.
 */
/**
 * Mint a bare self-signed JWT for Bearer auth on broker-mode endpoints
 * (/agents/:agentId/inbox, /agents/:agentId/replies, etc.). The receiving
 * route verifies the signature against the pubkey derived from iss (did:key)
 * and matches iss to the registered agent's DID — see
 * @nova/a2a-server/auth/self-ucan. No prf chain; no capability grant needed
 * because the endpoints only prove the caller is the agent they claim to be,
 * not that they're authorized to invoke any particular skill.
 */
export function mintSelfAuthToken(opts: {
  senderDid: string;
  senderPrivateKeyPem: string;
  ttlSeconds?: number;  // default 300
}): string {
  const ttl = opts.ttlSeconds ?? 300;
  const now = Math.floor(Date.now() / 1000);
  const payload: UcanPayload = {
    iss: opts.senderDid,
    aud: opts.senderDid,     // self-scoped; auth route only checks signature + iss-match
    exp: now + ttl,
    nbf: now,
    att: [],
    prf: [],
    jti: crypto.randomUUID(),
  };
  const privateKey = crypto.createPrivateKey(opts.senderPrivateKeyPem);
  return buildUcanJwt(payload, privateKey);
}

export function mintInvocationToken(opts: MintOpts): string {
  const ttl = opts.ttlSeconds ?? 300;
  const now = Math.floor(Date.now() / 1000);
  const { payload: grantPayload } = parseUcanJwt(opts.grantJwt);
  const novaDid = grantPayload.iss;
  if (!novaDid) throw new Error('Grant is missing iss (Nova gateway DID) — cannot mint');

  const att: UcanCapability[] = [{ with: opts.scope, can: 'invoke' }];
  const payload: UcanPayload = {
    iss: opts.senderDid,
    aud: novaDid,
    exp: now + ttl,
    nbf: now,
    att,
    prf: [opts.grantJwt],
    jti: crypto.randomUUID(),
  };
  const privateKey = crypto.createPrivateKey(opts.senderPrivateKeyPem);
  return buildUcanJwt(payload, privateKey);
}
