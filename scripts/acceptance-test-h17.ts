/**
 * H17 — Grant-pickup auth hardening
 *
 * Verifies the claim-secret/commitment scheme that gates GET /register/status.
 *
 * Test cases:
 *   1. Register WITH commitment → poll without secret → no grant returned
 *   2. Same register → poll with WRONG secret → no grant, fail counter ticks
 *   3. Same register → 3 wrong secrets → claim is locked (CLAIM_LOCKED)
 *   4. Operator reissue → fail counter cleared → poll with CORRECT secret → grant returned
 *   5. After grant claimed → second poll returns no grant (one-shot preserved)
 *   6. Reissue with clearClaimCommitment → poll without secret → grant returned
 *   7. Legacy registration (no commitment) → poll without secret → grant returned
 *      (backwards-compat path; flips off when NOVA_REQUIRE_CLAIM_SECRET=true)
 *
 * Prerequisites:
 *   - Redis on localhost:6379
 *   - admin-api on :3005
 *   - a2a-server on :3001
 *   - ADMIN_TOKEN env var
 */
import crypto from 'crypto';

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:3005';
const A2A_URL = process.env.A2A_URL || 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token-replace-before-prod-use';

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

function bs58encode(buf: Buffer): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n = n / 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

function generateClaimSecret(): { secret: string; commitment: string } {
  const raw = crypto.randomBytes(32);
  const secret = raw.toString('base64url');
  const commitment = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  return { secret, commitment };
}

async function newAgent(tenantId: string, agentId: string, withCommitment: boolean) {
  // Mint a fresh invite for this agentId
  const inviteRes = await adminFetch(`/admin/tenants/${tenantId}/invites`, {
    method: 'POST',
    body: JSON.stringify({ agentIdHint: agentId, ttlSeconds: 600 }),
  });
  assert(inviteRes.status === 201, `invite mint should return 201, got ${inviteRes.status}`);
  const invite = await inviteRes.json() as any;

  // Generate identity
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as any;
  const rawPub = Buffer.from(jwk.x, 'base64url');
  const did = encodeDidKey(rawPub);

  // Generate commitment (optional)
  let secret: string | undefined;
  let commitment: string | undefined;
  if (withCommitment) {
    const sc = generateClaimSecret();
    secret = sc.secret;
    commitment = sc.commitment;
  }

  // Register
  const body: any = {
    invite: invite.token,
    agentId,
    name: `H17 ${agentId}`,
    description: 'H17 acceptance test subject',
    publicKey: rawPub.toString('base64'),
    did,
    skills: [{ id: '__sender_only', name: 'Sender only', description: 'sender-only' }],
  };
  if (commitment) body.claimCommitment = commitment;

  const regRes = await a2aFetch('/register', { method: 'POST', body: JSON.stringify(body) });
  assert(regRes.status === 201, `register should return 201, got ${regRes.status}: ${await regRes.text()}`);

  // Approve
  const approveRes = await adminFetch(`/admin/tenants/${tenantId}/agents/${agentId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ trustTier: 1, ucanExpiryDays: 30, allowedSkills: ['*'] }),
  });
  assert(approveRes.status === 200, `approve should return 200, got ${approveRes.status}: ${await approveRes.text()}`);

  // Let admin → a2a propagation settle (Redis publish + status fetch)
  await sleep(200);

  return { secret, commitment, did };
}

async function pollStatus(tenantId: string, agentId: string, secret?: string) {
  const headers: Record<string, string> = {};
  if (secret) headers['x-claim-secret'] = secret;
  const res = await a2aFetch(`/register/status/${tenantId}/${agentId}`, { headers });
  return res.json() as Promise<any>;
}

async function reissueGrant(tenantId: string, agentId: string, opts: { clearCommitment?: boolean } = {}) {
  const body = opts.clearCommitment ? { clearClaimCommitment: true, reason: 'h17-test' } : {};
  const res = await adminFetch(`/admin/tenants/${tenantId}/agents/${agentId}/ucans/reissue`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  assert(res.status === 200, `reissue should return 200, got ${res.status}: ${await res.text()}`);
  await sleep(200);
}

async function main() {
  console.log('═══ H17 Grant-Pickup Auth Hardening ═══\n');

  // Setup tenant
  const slug = `h17-${Date.now()}`;
  const tenantRes = await adminFetch('/admin/tenants', {
    method: 'POST',
    body: JSON.stringify({ name: 'H17 Test', slug }),
  });
  assert(tenantRes.status === 201, `tenant create should return 201, got ${tenantRes.status}`);
  const tenant = await tenantRes.json() as any;
  console.log(`[setup] Tenant ${tenant.id}\n`);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- Test 1: Poll without secret returns no grant ---');
  // ─────────────────────────────────────────────────────────────────────────
  const a1 = await newAgent(tenant.id, 'agent-1', true);
  const r1 = await pollStatus(tenant.id, 'agent-1');
  assert(r1.status === 'active', `expected active, got ${r1.status}`);
  assert(!r1.grant, 'no grant should be returned without secret');
  console.log('[PASS] Active status returned, grant withheld\n');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- Test 2: Wrong secret returns no grant, increments counter ---');
  // ─────────────────────────────────────────────────────────────────────────
  const r2 = await pollStatus(tenant.id, 'agent-1', 'wrong-secret-attempt-1');
  assert(r2.status === 'active', 'still active');
  assert(!r2.grant, 'wrong secret must not yield grant');
  assert(r2.error !== 'CLAIM_LOCKED', 'should not be locked yet');
  console.log('[PASS] Wrong secret rejected without lockout\n');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- Test 3: 3 wrong secrets locks the claim ---');
  // ─────────────────────────────────────────────────────────────────────────
  await pollStatus(tenant.id, 'agent-1', 'wrong-secret-attempt-2');
  const r3 = await pollStatus(tenant.id, 'agent-1', 'wrong-secret-attempt-3');
  assert(r3.error === 'CLAIM_LOCKED', `expected CLAIM_LOCKED, got ${JSON.stringify(r3)}`);
  // After lockout, even the correct secret can't recover without reissue
  const r3b = await pollStatus(tenant.id, 'agent-1', a1.secret!);
  assert(!r3b.grant, 'after lockout the original secret should also fail');
  console.log('[PASS] Claim locked after threshold\n');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- Test 4: Reissue clears counter, correct secret works ---');
  // ─────────────────────────────────────────────────────────────────────────
  await reissueGrant(tenant.id, 'agent-1');
  const r4 = await pollStatus(tenant.id, 'agent-1', a1.secret!);
  assert(r4.status === 'active', 'still active');
  assert(!!r4.grant?.jwt, `correct secret post-reissue should yield grant, got ${JSON.stringify(r4)}`);
  console.log('[PASS] Reissue + correct secret restored access\n');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- Test 5: One-shot preserved — second poll returns no grant ---');
  // ─────────────────────────────────────────────────────────────────────────
  const r5 = await pollStatus(tenant.id, 'agent-1', a1.secret!);
  assert(!r5.grant, 'second poll must not re-deliver grant');
  console.log('[PASS] Grant claim is one-shot\n');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- Test 6: Reissue with clearClaimCommitment lets unauthenticated poll succeed ---');
  // ─────────────────────────────────────────────────────────────────────────
  const a6 = await newAgent(tenant.id, 'agent-2', true);
  await reissueGrant(tenant.id, 'agent-2', { clearCommitment: true });
  const r6 = await pollStatus(tenant.id, 'agent-2');  // no secret
  assert(!!r6.grant?.jwt, `cleared-commitment poll should yield grant, got ${JSON.stringify(r6)}`);
  // The original secret would also work, but the point is no secret was needed
  void a6;
  console.log('[PASS] clearClaimCommitment escape hatch works\n');

  // ─────────────────────────────────────────────────────────────────────────
  console.log('--- Test 7: Legacy registration (no commitment) — backwards compat ---');
  // ─────────────────────────────────────────────────────────────────────────
  // NB: this case fails when NOVA_REQUIRE_CLAIM_SECRET=true on the server.
  // Skip the assertion if the server is in strict mode.
  await newAgent(tenant.id, 'agent-3', false);
  const r7 = await pollStatus(tenant.id, 'agent-3');
  if (process.env.NOVA_REQUIRE_CLAIM_SECRET === 'true') {
    console.log('[SKIP] Strict mode is on — legacy registrations are rejected at /register');
  } else {
    assert(!!r7.grant?.jwt, `legacy poll should yield grant in compat mode, got ${JSON.stringify(r7)}`);
    console.log('[PASS] Legacy path delivers grant unauthenticated (compat mode)\n');
  }

  console.log('═══ All H17 tests passed ═══');
}

main().catch(err => { console.error(err); process.exit(1); });
