/**
 * P2.7 — Key rotation acceptance test.
 *
 * Exercises the full rotate-key flow end-to-end against running admin-api +
 * a2a-server:
 *   1. Create tenant + invite
 *   2. Self-register an agent (known Ed25519 keypair)
 *   3. Approve agent
 *   4. Claim self-UCAN via /register/status
 *   5. Confirm PoP renew works with the current key
 *   6. Rotate to a fresh keypair with PoP signature over old key
 *   7. Assert: agent record updated, old UCANs revoked, new UCAN verifies,
 *      trust-registry rebuilt, old key rejected on subsequent renew
 *
 * Prerequisites:
 *   - Redis running on localhost:6379
 *   - Admin API on localhost:3005, A2A server on localhost:3001
 *   - ADMIN_TOKEN env var (default: nova-admin-dev-token)
 */

import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import bs58 from 'bs58';

const ADMIN_URL = process.env['ADMIN_URL'] || 'http://127.0.0.1:3005';
const A2A_URL = process.env['A2A_URL'] || 'http://localhost:3001';
const ADMIN_TOKEN = process.env['ADMIN_TOKEN'] || 'nova-admin-dev-token';
const DATA_ROOT = process.env['NOVA_DATA_ROOT'] || path.resolve(__dirname, '..', 'data');

const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

interface Keypair { did: string; publicKey: string; privateKeyPem: string; }

function generateKeypair(): Keypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const raw = Buffer.from(jwk.x, 'base64url');
  const did = `did:key:z${bs58.encode(Buffer.concat([ED25519_MULTICODEC_PREFIX, raw]))}`;
  return {
    did,
    publicKey: raw.toString('base64'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
  };
}

function sign(privateKeyPem: string, message: string): string {
  return crypto.sign(null, Buffer.from(message, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64url');
}

function assert(c: boolean, msg: string): asserts c {
  if (!c) { console.error(`[FAIL] ${msg}`); process.exit(1); }
}

async function adminFetch(p: string, opts: RequestInit = {}) {
  return fetch(`${ADMIN_URL}${p}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
}

async function main() {
  console.log('=== P2.7 KEY ROTATION ACCEPTANCE TEST ===\n');

  const tenantSlug = 'p27-' + Math.random().toString(36).slice(2, 8);
  const agentId = 'rot_' + Math.random().toString(36).slice(2, 8);

  // 1. Create tenant
  console.log('--- Create tenant ---');
  const tRes = await adminFetch('/admin/tenants', {
    method: 'POST',
    body: JSON.stringify({ name: 'P2.7 Rotation', slug: tenantSlug, plan: 'developer' }),
  });
  assert(tRes.status === 201, `Create tenant -> ${tRes.status}`);
  const tenant = await tRes.json() as { id: string };
  console.log(`[PASS] Tenant ${tenant.id}\n`);

  // 2. Mint invite
  console.log('--- Mint invite ---');
  const invRes = await adminFetch(`/admin/tenants/${tenant.id}/invites`, {
    method: 'POST',
    body: JSON.stringify({ agentIdHint: agentId, ttlSeconds: 3600 }),
  });
  assert(invRes.status === 201, `Mint invite -> ${invRes.status}`);
  const invite = await invRes.json() as { token: string };
  console.log(`[PASS] Invite minted\n`);

  // 3. Self-register
  console.log('--- Self-register agent ---');
  const oldKey = generateKeypair();
  const regRes = await fetch(`${A2A_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invite: invite.token,
      agentId,
      name: 'Rotation Test Agent',
      description: 'Exercises P2.7 key rotation',
      publicKey: oldKey.publicKey,
      did: oldKey.did,
      skills: [{ id: 'ping', name: 'Ping', description: 'Health probe' }],
    }),
  });
  assert(regRes.status === 201, `Register -> ${regRes.status}: ${await regRes.text()}`);
  console.log(`[PASS] Agent registered (pending)\n`);

  // 4. Approve
  console.log('--- Approve agent ---');
  const apprRes = await adminFetch(`/admin/tenants/${tenant.id}/agents/${agentId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ trustTier: 2, allowedSkills: ['ping'], ucanExpiryDays: 30 }),
  });
  assert(apprRes.status === 200, `Approve -> ${apprRes.status}`);
  console.log(`[PASS] Agent approved\n`);

  // 5. Claim self-UCAN
  console.log('--- Claim self-UCAN ---');
  const statusRes = await fetch(`${A2A_URL}/register/status/${tenant.id}/${agentId}`);
  assert(statusRes.status === 200, `Status -> ${statusRes.status}`);
  const status = await statusRes.json() as { status: string; ucan?: { jwt: string; cid: string } };
  assert(status.status === 'active' && !!status.ucan, `Expected active status + UCAN claim, got ${JSON.stringify(status)}`);
  const oldUcanCid = status.ucan!.cid;
  console.log(`[PASS] Claimed UCAN cid=${oldUcanCid.slice(0, 12)}...\n`);

  // 6. Prove old key works on PoP renew (sanity)
  console.log('--- PoP renew with old key (sanity) ---');
  const nonce1Res = await fetch(`${ADMIN_URL}/admin/tenants/${tenant.id}/ucans/renew?did=${encodeURIComponent(oldKey.did)}&agentId=${agentId}`);
  assert(nonce1Res.status === 200, `renew-nonce -> ${nonce1Res.status}`);
  const { nonce: nonce1 } = await nonce1Res.json() as { nonce: string };
  const sig1 = sign(oldKey.privateKeyPem, nonce1);
  const renewRes = await fetch(`${ADMIN_URL}/admin/tenants/${tenant.id}/ucans/renew`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ did: oldKey.did, agentId, nonce: nonce1, signature: sig1 }),
  });
  assert(renewRes.status === 200, `renew -> ${renewRes.status}: ${await renewRes.text()}`);
  console.log(`[PASS] Old-key renew works\n`);

  // 7. Rotate
  console.log('--- Rotate key ---');
  const newKey = generateKeypair();
  const rnRes = await fetch(`${ADMIN_URL}/admin/tenants/${tenant.id}/ucans/renew?did=${encodeURIComponent(oldKey.did)}&agentId=${agentId}`);
  const { nonce: rotNonce } = await rnRes.json() as { nonce: string };
  const rotSig = sign(oldKey.privateKeyPem, `${rotNonce}|${newKey.did}|${newKey.publicKey}`);
  const rotRes = await fetch(`${ADMIN_URL}/admin/tenants/${tenant.id}/agents/${agentId}/rotate-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oldDid: oldKey.did,
      newDid: newKey.did,
      newPublicKey: newKey.publicKey,
      nonce: rotNonce,
      signature: rotSig,
    }),
  });
  if (rotRes.status !== 200) { console.error(`rotate -> ${rotRes.status}: ${await rotRes.text()}`); process.exit(1); }
  const rot = await rotRes.json() as {
    jwt: string; cid: string; newDid: string; revokedCids: string[]; trustTier: number; allowedSkills: string[];
  };
  assert(rot.newDid === newKey.did, 'newDid roundtrip');
  assert(rot.trustTier === 2, 'Trust tier carried over');
  assert(rot.allowedSkills[0] === 'ping', 'allowedSkills carried over');
  assert(rot.revokedCids.includes(oldUcanCid), `Old self-UCAN cid=${oldUcanCid.slice(0, 8)} should be revoked`);
  assert(!rot.revokedCids.includes(rot.cid), 'Fresh UCAN cid must not collide with any revoked cid');
  assert(rot.cid !== oldUcanCid, `Fresh cid must differ from old cid (both=${rot.cid})`);
  console.log(`[PASS] Rotated; revoked ${rot.revokedCids.length} UCAN(s); new cid=${rot.cid} (differs from old ${oldUcanCid})\n`);

  // 8. Verify agent record
  console.log('--- Verify agent record updated ---');
  const agentFile = path.join(DATA_ROOT, 'tenants', tenant.id, 'agents', agentId, 'agent-config.json');
  const cfg = JSON.parse(await fsp.readFile(agentFile, 'utf8'));
  assert(cfg.did === newKey.did, `Agent DID should be newDid, got ${cfg.did}`);
  assert(cfg.publicKey === newKey.publicKey, 'Agent publicKey should be newPublicKey');
  console.log(`[PASS] Agent config updated\n`);

  // 9. Verify trust registry rebuilt
  console.log('--- Verify trust registry ---');
  const oldDidHash = crypto.createHash('sha256').update(oldKey.did).digest('hex');
  const newDidHash = crypto.createHash('sha256').update(newKey.did).digest('hex');
  const trustDir = path.join(DATA_ROOT, 'tenants', tenant.id, 'agents', agentId, 'trust-registry');
  const oldExists = await fsp.access(path.join(trustDir, oldDidHash + '.json')).then(() => true).catch(() => false);
  const newExists = await fsp.access(path.join(trustDir, newDidHash + '.json')).then(() => true).catch(() => false);
  assert(!oldExists, 'Old DID actor should be removed');
  assert(newExists, 'New DID actor should be added');
  const newActor = JSON.parse(await fsp.readFile(path.join(trustDir, newDidHash + '.json'), 'utf8'));
  assert(newActor.tier === 2, 'Actor tier preserved');
  console.log(`[PASS] Trust registry rebuilt\n`);

  // 10. Verify old UCAN tombstone exists
  console.log('--- Verify old UCAN revoked ---');
  const tombstone = path.join(DATA_ROOT, 'ucans', 'revoked', oldUcanCid + '.json');
  const tombExists = await fsp.access(tombstone).then(() => true).catch(() => false);
  assert(tombExists, `Revocation tombstone missing at ${tombstone}`);
  console.log(`[PASS] Old UCAN tombstoned\n`);

  // 11. Old key must no longer renew
  console.log('--- Verify old key rejected ---');
  const staleNonceRes = await fetch(`${ADMIN_URL}/admin/tenants/${tenant.id}/ucans/renew?did=${encodeURIComponent(oldKey.did)}&agentId=${agentId}`);
  const { nonce: staleNonce } = await staleNonceRes.json() as { nonce: string };
  const staleSig = sign(oldKey.privateKeyPem, staleNonce);
  const staleRenew = await fetch(`${ADMIN_URL}/admin/tenants/${tenant.id}/ucans/renew`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ did: oldKey.did, agentId, nonce: staleNonce, signature: staleSig }),
  });
  assert(staleRenew.status === 401, `Old-key renew should 401, got ${staleRenew.status}`);
  console.log(`[PASS] Old key rejected\n`);

  // 12. New key must renew successfully
  console.log('--- Verify new key works ---');
  const freshNonceRes = await fetch(`${ADMIN_URL}/admin/tenants/${tenant.id}/ucans/renew?did=${encodeURIComponent(newKey.did)}&agentId=${agentId}`);
  const { nonce: freshNonce } = await freshNonceRes.json() as { nonce: string };
  const freshSig = sign(newKey.privateKeyPem, freshNonce);
  const freshRenew = await fetch(`${ADMIN_URL}/admin/tenants/${tenant.id}/ucans/renew`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ did: newKey.did, agentId, nonce: freshNonce, signature: freshSig }),
  });
  assert(freshRenew.status === 200, `New-key renew should 200, got ${freshRenew.status}: ${await freshRenew.text()}`);
  console.log(`[PASS] New key works\n`);

  // 13. Replay the rotation request — must fail (nonce consumed)
  console.log('--- Verify nonce replay blocked ---');
  const replay = await fetch(`${ADMIN_URL}/admin/tenants/${tenant.id}/agents/${agentId}/rotate-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oldDid: oldKey.did, newDid: newKey.did, newPublicKey: newKey.publicKey,
      nonce: rotNonce, signature: rotSig,
    }),
  });
  assert(replay.status === 400 || replay.status === 401, `Replay should reject, got ${replay.status}`);
  console.log(`[PASS] Nonce replay blocked\n`);

  // Cleanup
  console.log('--- Cleanup ---');
  await adminFetch(`/admin/tenants/${tenant.id}`, { method: 'DELETE' });
  console.log(`Soft-deleted tenant ${tenant.id}\n`);

  console.log('=== ALL P2.7 ROTATION TESTS PASSED ===');
}

main().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
