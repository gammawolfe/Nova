/**
 * P2.9 — Opportunistic revocation check acceptance test.
 *
 * Exercises GET /agents/:agentId/health end-to-end:
 *   1. Create tenant + invite + register agent + approve + claim UCAN
 *   2. Probe health without cid → agentStatus=active
 *   3. Probe health with self-UCAN cid → found=true, revoked=false
 *   4. Revoke that UCAN via admin-api
 *   5. Probe health → revoked=true
 *   6. Probe with non-existent cid → found=false, revoked=false
 *   7. Probe with malformed cid → 400
 *   8. Deregister agent → agentStatus=deregistered
 *
 * Prerequisites: admin-api, a2a-server, Redis running.
 */

import crypto from 'crypto';
import bs58 from 'bs58';

const ADMIN_URL = process.env['ADMIN_URL'] || 'http://127.0.0.1:3005';
const A2A_URL = process.env['A2A_URL'] || 'http://localhost:3001';
const ADMIN_TOKEN = process.env['ADMIN_TOKEN'] || 'nova-admin-dev-token';

const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

function generateKeypair() {
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
  console.log('=== P2.9 STATUS-CHECK ACCEPTANCE TEST ===\n');

  const tenantSlug = 'p29-' + Math.random().toString(36).slice(2, 8);
  const agentId = 'hc_' + Math.random().toString(36).slice(2, 8);

  console.log('--- Create tenant ---');
  const tRes = await adminFetch('/admin/tenants', {
    method: 'POST',
    body: JSON.stringify({ name: 'P2.9 Health', slug: tenantSlug, plan: 'developer' }),
  });
  assert(tRes.status === 201, `Create tenant -> ${tRes.status}`);
  const tenant = await tRes.json() as { id: string };
  console.log(`[PASS] Tenant ${tenant.id}\n`);

  console.log('--- Mint invite ---');
  const invRes = await adminFetch(`/admin/tenants/${tenant.id}/invites`, {
    method: 'POST',
    body: JSON.stringify({ agentIdHint: agentId, ttlSeconds: 3600 }),
  });
  assert(invRes.status === 201, `Mint invite -> ${invRes.status}`);
  const invite = await invRes.json() as { token: string };
  console.log(`[PASS] Invite minted\n`);

  console.log('--- Self-register agent ---');
  const kp = generateKeypair();
  const regRes = await fetch(`${A2A_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invite: invite.token,
      agentId,
      name: 'Health Probe Agent',
      description: 'Exercises P2.9 status check',
      publicKey: kp.publicKey,
      did: kp.did,
      skills: [{ id: 'ping', name: 'Ping', description: 'Health probe' }],
    }),
  });
  assert(regRes.status === 201, `Register -> ${regRes.status}`);
  console.log(`[PASS] Agent registered\n`);

  console.log('--- Approve agent ---');
  const apprRes = await adminFetch(`/admin/tenants/${tenant.id}/agents/${agentId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ trustTier: 1, allowedSkills: ['ping'], ucanExpiryDays: 30 }),
  });
  assert(apprRes.status === 200, `Approve -> ${apprRes.status}`);
  console.log(`[PASS] Agent approved\n`);

  console.log('--- Claim UCAN ---');
  const statusRes = await fetch(`${A2A_URL}/register/status/${tenant.id}/${agentId}`);
  const status = await statusRes.json() as { ucan?: { cid: string } };
  assert(!!status.ucan, 'UCAN claim should be available');
  const ucanCid = status.ucan!.cid;
  console.log(`[PASS] UCAN claimed cid=${ucanCid}\n`);

  // 1. Health without cid → agentStatus=active
  console.log('--- Health (no cid) on active agent ---');
  const h1 = await fetch(`${A2A_URL}/agents/${agentId}/health`);
  assert(h1.status === 200, `health -> ${h1.status}`);
  const h1Body = await h1.json() as any;
  assert(h1Body.agentStatus === 'active', `expected active, got ${h1Body.agentStatus}`);
  assert(h1Body.ucan === undefined, 'ucan field should be absent when no cid passed');
  console.log(`[PASS] agentStatus=active, ucan omitted\n`);

  // 2. Health with valid cid → found=true, revoked=false
  console.log('--- Health with valid unrevoked cid ---');
  const h2 = await fetch(`${A2A_URL}/agents/${agentId}/health?ucanCid=${ucanCid}`);
  const h2Body = await h2.json() as any;
  assert(h2Body.ucan?.found === true, `ucan.found should be true for issued cid`);
  assert(h2Body.ucan?.revoked === false, `ucan.revoked should be false before revoke`);
  assert(typeof h2Body.ucan?.expiresAt === 'string', 'expiresAt should be populated from issued metadata');
  console.log(`[PASS] found=true revoked=false expiresAt=${h2Body.ucan.expiresAt}\n`);

  // 3. Revoke the UCAN via admin-api
  console.log('--- Revoke UCAN ---');
  const revRes = await adminFetch(`/admin/tenants/${tenant.id}/ucans/revoke`, {
    method: 'POST',
    body: JSON.stringify({ cid: ucanCid }),
  });
  assert(revRes.status === 200, `revoke -> ${revRes.status}`);
  console.log(`[PASS] UCAN revoked\n`);

  // 4. Health now reports revoked=true
  console.log('--- Health after revoke ---');
  const h3 = await fetch(`${A2A_URL}/agents/${agentId}/health?ucanCid=${ucanCid}`);
  const h3Body = await h3.json() as any;
  assert(h3Body.ucan?.revoked === true, `ucan.revoked should be true after revoke, got ${JSON.stringify(h3Body.ucan)}`);
  console.log(`[PASS] revoked=true\n`);

  // 5. Non-existent cid → found=false, revoked=false
  console.log('--- Health with non-existent cid ---');
  const fakeCid = '0'.repeat(32);
  const h4 = await fetch(`${A2A_URL}/agents/${agentId}/health?ucanCid=${fakeCid}`);
  const h4Body = await h4.json() as any;
  assert(h4Body.ucan?.found === false, 'found should be false for unknown cid');
  assert(h4Body.ucan?.revoked === false, 'revoked should be false when no tombstone exists');
  console.log(`[PASS] found=false revoked=false for unknown cid\n`);

  // 6. Malformed cid → 400
  console.log('--- Health with malformed cid ---');
  const h5 = await fetch(`${A2A_URL}/agents/${agentId}/health?ucanCid=../../etc/passwd`);
  assert(h5.status === 400, `malformed cid should 400, got ${h5.status}`);
  const h5Body = await h5.json() as any;
  assert(h5Body.error === 'INVALID_CID', `expected INVALID_CID, got ${h5Body.error}`);
  console.log(`[PASS] malformed cid rejected\n`);

  // 7. Deregister → agentStatus=deregistered
  console.log('--- Deregister agent ---');
  const delRes = await adminFetch(`/admin/tenants/${tenant.id}/agents/${agentId}`, { method: 'DELETE' });
  assert(delRes.status === 200, `deregister -> ${delRes.status}`);
  // Small pause — deregistration publishes a Redis lifecycle event asynchronously.
  await new Promise(r => setTimeout(r, 100));
  const h6 = await fetch(`${A2A_URL}/agents/${agentId}/health`);
  const h6Body = await h6.json() as any;
  assert(
    h6Body.agentStatus === 'deregistered' || h6Body.agentStatus === 'unknown',
    `post-deregister status should be deregistered or unknown, got ${h6Body.agentStatus}`,
  );
  console.log(`[PASS] agentStatus=${h6Body.agentStatus} after deregister\n`);

  // Cleanup
  console.log('--- Cleanup ---');
  await adminFetch(`/admin/tenants/${tenant.id}`, { method: 'DELETE' });
  console.log(`Soft-deleted tenant ${tenant.id}\n`);

  console.log('=== ALL P2.9 STATUS-CHECK TESTS PASSED ===');
}

main().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
