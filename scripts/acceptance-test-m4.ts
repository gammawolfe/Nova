/**
 * Milestone 4 — MCP onboarding pipeline
 *
 * Validates the invite → register → poll → UCAN claim flow that the
 * @nova/mcp-server drives on behalf of an AI runtime.
 *
 * Prerequisites:
 *   - Redis running on localhost:6379
 *   - Admin API running on localhost:3005
 *   - A2A server running on localhost:3001
 *   - ADMIN_TOKEN env var set (default: nova-admin-dev-token)
 */
import crypto from 'crypto';

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:3005';
const A2A_URL = process.env.A2A_URL || 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'nova-admin-dev-token';

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) { console.error(`[FAIL] ${message}`); process.exit(1); }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function adminFetch(path: string, opts: RequestInit = {}) {
  return fetch(`${ADMIN_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
      ...opts.headers,
    },
  });
}

async function a2aFetch(path: string, opts: RequestInit = {}) {
  return fetch(`${A2A_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });
}

function encodeDidKey(rawPublicKey: Buffer): string {
  const prefix = Uint8Array.of(0xed, 0x01);
  const prefixed = Buffer.concat([prefix, rawPublicKey]);
  return `did:key:z${bs58encode(prefixed)}`;
}

// Minimal bs58 (avoids pulling workspace dep into scripts)
function bs58encode(buf: Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + buf.toString('hex'));
  let result = '';
  while (num > 0n) { result = ALPHABET[Number(num % 58n)] + result; num = num / 58n; }
  for (const byte of buf) { if (byte === 0) result = '1' + result; else break; }
  return result;
}

async function main() {
  console.log('=== MILESTONE 4 ACCEPTANCE TEST: MCP onboarding ===\n');

  // --- Test 1: Operator creates a tenant ---
  console.log('--- Test 1: Create tenant ---');
  const tenantRes = await adminFetch('/admin/tenants', {
    method: 'POST',
    body: JSON.stringify({ name: 'M4 Household', slug: `m4-household-${Date.now()}`, plan: 'developer' }),
  });
  assert(tenantRes.status === 201, `expected 201, got ${tenantRes.status}`);
  const tenant = await tenantRes.json() as any;
  console.log(`[PASS] Tenant ${tenant.id} created\n`);

  // --- Test 2: Operator mints invite ---
  console.log('--- Test 2: Mint invite ---');
  const inviteRes = await adminFetch(`/admin/tenants/${tenant.id}/invites`, {
    method: 'POST',
    body: JSON.stringify({ ttlSeconds: 3600, agentIdHint: 'm4-agent' }),
  });
  assert(inviteRes.status === 201, `invite create should return 201, got ${inviteRes.status}`);
  const invite = await inviteRes.json() as any;
  assert(typeof invite.token === 'string' && invite.token.split('.').length === 3, 'invite token should be a JWT');
  console.log(`[PASS] Invite token minted (jti=${invite.jti})\n`);

  // --- Test 3: Agent generates Ed25519 identity and registers ---
  console.log('--- Test 3: Self-register agent with invite ---');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as any;
  const rawPub = Buffer.from(jwk.x, 'base64url');
  const did = encodeDidKey(rawPub);
  const agentId = 'm4-agent';

  const regRes = await a2aFetch('/register', {
    method: 'POST',
    body: JSON.stringify({
      invite: invite.token,
      agentId,
      name: 'M4 Agent',
      description: 'MCP acceptance test subject',
      publicKey: rawPub.toString('base64'),
      did,
      skills: [{ id: '__sender_only', name: 'Sender only', description: 'sender-only agent' }],
    }),
  });
  assert(regRes.status === 201, `register should return 201, got ${regRes.status}`);
  const reg = await regRes.json() as any;
  assert(reg.status === 'pending', 'registration should start pending');
  assert(reg.tenantId === tenant.id, `register must bind to invite.tenantId (${tenant.id}), got ${reg.tenantId}`);
  console.log(`[PASS] Agent registered pending at ${reg.statusUrl}\n`);

  // --- Test 4: Replaying the same invite must fail (one-time use) ---
  console.log('--- Test 4: Invite is one-time use ---');
  const replay = await a2aFetch('/register', {
    method: 'POST',
    body: JSON.stringify({
      invite: invite.token,
      agentId: 'm4-second',
      name: 'Should fail',
      publicKey: rawPub.toString('base64'),
      did,
      skills: [{ id: '__sender_only', name: 'Sender only', description: 'x' }],
    }),
  });
  assert(replay.status >= 400, `replay must fail, got ${replay.status}`);
  console.log('[PASS] Second use of invite rejected\n');

  // --- Test 5: Polling status before approval ---
  console.log('--- Test 5: Poll status before approval ---');
  const pendingStatus = await a2aFetch(`/register/status/${tenant.id}/${agentId}`);
  const pendingBody = await pendingStatus.json() as any;
  assert(pendingBody.status === 'pending', `expected pending, got ${pendingBody.status}`);
  assert(!pendingBody.grant, 'no grant before approval');
  console.log('[PASS] Status reports pending\n');

  // --- Test 6: Operator approves agent ---
  console.log('--- Test 6: Approve agent ---');
  const approveRes = await adminFetch(`/admin/tenants/${tenant.id}/agents/${agentId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ trustTier: 2, ucanExpiryDays: 7, allowedSkills: ['__sender_only'] }),
  });
  assert(approveRes.status === 200, `approve should return 200, got ${approveRes.status}`);
  console.log('[PASS] Agent approved\n');

  // --- Test 7: Polling after approval claims UCAN ---
  console.log('--- Test 7: Poll claims UCAN (one-time) ---');
  await sleep(200);
  const claim1 = await a2aFetch(`/register/status/${tenant.id}/${agentId}`);
  const claim1Body = await claim1.json() as any;
  assert(claim1Body.status === 'active', `expected active, got ${claim1Body.status}`);
  assert(!!claim1Body.grant?.jwt, 'first post-approval fetch must include grant');
  assert(claim1Body.grant.jwt.split('.').length === 3, 'grant JWT shape');
  console.log(`[PASS] Grant claimed (expires ${claim1Body.grant.expiresAt})\n`);

  // --- Test 8: Second poll must NOT re-deliver UCAN ---
  console.log('--- Test 8: UCAN claim is one-time ---');
  const claim2 = await a2aFetch(`/register/status/${tenant.id}/${agentId}`);
  const claim2Body = await claim2.json() as any;
  assert(claim2Body.status === 'active', 'still active');
  assert(!claim2Body.grant, 'second fetch must not re-deliver grant');
  console.log('[PASS] Second fetch has no UCAN\n');

  // --- Test 9: Agent shows up in discovery ---
  console.log('--- Test 9: Agent appears in /discover ---');
  const discRes = await a2aFetch('/discover');
  const discBody = await discRes.json() as any;
  const found = Array.isArray(discBody) ? discBody.find((a: any) => a.agentId === agentId)
    : Array.isArray(discBody.agents) ? discBody.agents.find((a: any) => a.agentId === agentId)
    : null;
  assert(!!found, `approved agent must be discoverable: got ${JSON.stringify(discBody).slice(0, 200)}`);
  console.log('[PASS] Agent discoverable\n');

  console.log('=== MILESTONE 4 ACCEPTANCE TEST PASSED ===');
}

main().catch(err => { console.error(err); process.exit(1); });
