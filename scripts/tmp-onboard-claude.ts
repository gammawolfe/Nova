/**
 * Fresh onboarding for Claude Code under the sender-signed UCAN model.
 * Writes the identity + grant cache in the same shape the @nova/mcp-server
 * expects so a future MCP client pointed at ~/.nova/ picks it up without
 * further ceremony.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';

const ADMIN_URL = 'http://127.0.0.1:3005';
const A2A_URL = 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token-replace-before-prod-use';
const AGENT_ID = 'claude-code';
const AGENT_NAME = 'Claude Code';
const AGENT_DESC = 'Anthropic Claude Code CLI acting as a Nova sender agent for Wolfe Dev.';

const NOVA_HOME = path.join(process.env.HOME!, '.nova');
const AGENTS_DIR = path.join(NOVA_HOME, 'agents');
const TENANT_CONFIG_PATH = path.join(NOVA_HOME, 'tenant.json');

function b64urlToDidKey(rawPub: Buffer): string {
  const prefixed = Buffer.concat([Uint8Array.of(0xed, 0x01), rawPub]);
  return 'did:key:z' + bs58.encode(prefixed);
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function get(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function adminPost(path: string, body: unknown) {
  return post(`${ADMIN_URL}${path}`, body, { Authorization: `Bearer ${ADMIN_TOKEN}` });
}

async function main() {
  console.log('\n=== Onboarding claude-code (sender-signed UCAN model) ===\n');

  // 1. Create tenant
  console.log('1. Creating tenant Wolfe Dev');
  const tenantRes = await adminPost('/admin/tenants', { name: 'Wolfe Dev', slug: 'wolfe-dev' });
  if (tenantRes.status !== 201) throw new Error(`tenant creation failed: ${tenantRes.status} ${JSON.stringify(tenantRes.body)}`);
  const tenantId = tenantRes.body.id;
  console.log(`   tenantId=${tenantId}`);

  // 2. Mint invite
  console.log('2. Minting invite');
  const inviteRes = await adminPost(`/admin/tenants/${tenantId}/invites`, { agentIdHint: AGENT_ID, ttlSeconds: 3600 });
  if (inviteRes.status !== 201) throw new Error(`invite mint failed: ${inviteRes.status} ${JSON.stringify(inviteRes.body)}`);
  const invite = inviteRes.body.token;

  // 3. Generate identity (matches @nova/shared/src/identity.ts:generateIdentity)
  console.log('3. Generating Ed25519 identity');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const rawPub = Buffer.from(jwk.x, 'base64url');
  const did = b64urlToDidKey(rawPub);
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const publicKeyB64 = rawPub.toString('base64');
  console.log(`   did=${did}`);

  // 4. Register
  console.log('4. Registering agent');
  const reg = await post(`${A2A_URL}/register`, {
    invite,
    agentId: AGENT_ID,
    name: AGENT_NAME,
    description: AGENT_DESC,
    publicKey: publicKeyB64,
    did,
    skills: [{ id: 'chat', name: 'Chat', description: 'General chat — accepts a text prompt, returns a text response.', tags: ['chat', 'general'] }],
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  console.log(`   status=${reg.body.status}`);

  // 5. Approve at tier 3
  console.log('5. Operator approves agent at trust tier 3');
  const approveRes = await adminPost(`/admin/tenants/${tenantId}/agents/${AGENT_ID}/approve`, { trustTier: 3 });
  if (approveRes.status !== 200) throw new Error(`approve failed: ${approveRes.status} ${JSON.stringify(approveRes.body)}`);

  // 6. Claim grant via /register/status
  console.log('6. Claiming approval grant');
  const status = await get(`${A2A_URL}/register/status/${tenantId}/${AGENT_ID}`);
  if (!status.body.grant) throw new Error(`grant not in status response: ${JSON.stringify(status.body)}`);
  const grant = status.body.grant;
  console.log(`   grantCid=${grant.cid} expiresAt=${grant.expiresAt}`);

  // 7. Persist MCP-compatible files
  console.log('7. Writing MCP-compatible identity + grant cache');
  fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 0o700 });

  const identityPath = path.join(AGENTS_DIR, `${AGENT_ID}.json`);
  const identity = {
    agentId: AGENT_ID,
    did,
    publicKey: publicKeyB64,
    privateKeyPem,
    createdAt: new Date().toISOString(),
    keyBackend: 'file' as const,
  };
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), { mode: 0o600 });

  const grantCachePath = path.join(AGENTS_DIR, `${AGENT_ID}.ucan.json`);
  const grantCache = {
    agentId: AGENT_ID,
    grant: { jwt: grant.jwt, cid: grant.cid, expiresAt: grant.expiresAt },
  };
  fs.writeFileSync(grantCachePath, JSON.stringify(grantCache, null, 2), { mode: 0o600 });

  const tenantCfg = {
    novaUrl: A2A_URL,
    tenantId,
    agentIdHint: AGENT_ID,
    joinedAt: new Date().toISOString(),
  };
  fs.writeFileSync(TENANT_CONFIG_PATH, JSON.stringify(tenantCfg, null, 2), { mode: 0o600 });

  // 8. Verify via /discover
  console.log('8. Verifying /discover entry');
  const disc = await get(`${A2A_URL}/discover`);
  const self = (disc.body as any[]).find(a => a.agentId === AGENT_ID);
  if (!self) throw new Error('agent not in /discover');
  console.log(`   ✓ ${self.agentId} active in ${self.tenantId}`);

  console.log('\n=== CLAUDE-CODE ONBOARDED ===');
  console.log(`tenant:    ${tenantId}`);
  console.log(`did:       ${did}`);
  console.log(`grant cid: ${grant.cid}`);
  console.log(`identity:  ${identityPath}`);
  console.log(`grant:     ${grantCachePath}`);
  console.log(`tenant:    ${TENANT_CONFIG_PATH}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
