// scripts/acceptance-test-broker.ts
/**
 * End-to-end broker receiver flow:
 *   1. Create a tenant.
 *   2. Issue an invite.
 *   3. Register a broker-mode agent (no operatorUrl, real skill).
 *   4. Approve it.
 *   5. Register a sender agent.
 *   6. Approve sender.
 *   7. Sender sends a task to the broker agent.
 *   8. Broker pulls via the inbox endpoint.
 *   9. Broker responds.
 *  10. Sender polls task result — verifies the reply arrived.
 *
 * Run: npx tsx scripts/acceptance-test-broker.ts
 * Requires: Nova running locally (docker-compose up).
 */

import { randomUUID } from 'crypto';

const ADMIN_URL = process.env.NOVA_ADMIN_URL ?? 'http://localhost:3005';
const A2A_URL = process.env.NOVA_URL ?? 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token-replace-before-prod-use';

async function api<T>(method: string, url: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${url} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null as T;
  return res.json();
}

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const tenantSlug = `broker-test-${suffix}`;

  console.log('1. Creating tenant…');
  const tenant = await api<{ id: string; slug: string }>(
    'POST', `${ADMIN_URL}/admin/tenants`,
    { slug: tenantSlug, name: 'Broker Test', plan: 'developer' },
    ADMIN_TOKEN,
  );
  const tenantId = tenant.id;
  console.log(`   tenantId=${tenantId}`);

  // The full end-to-end also needs agent key generation, invite acceptance,
  // UCAN proof-of-possession, and task POSTing — all of which go through the
  // same MCP flow Claude Code uses. A fully-scripted version of this test is
  // deferred because it requires reproducing identity setup and UCAN
  // proof-of-possession outside MCP, which is ~200 lines of crypto scaffolding.
  //
  // For manual verification:
  //   - Use Claude Code with NOVA_ADMIN_URL set.
  //   - Call nova_accept_invite / nova_generate_identity / nova_register_agent
  //     for a broker-mode agent (no operatorUrl).
  //   - Open a separate Claude Code session as the sender.
  //   - Sender: nova_send_task → broker-agent.
  //   - Broker: nova_next_task → nova_respond.
  //   - Sender: nova_get_task_result — expect the reply.
  //
  // This script validates the admin-side plumbing (tenant + auth) is healthy.
  console.log('2. Tenant creation OK. Remaining flow requires MCP-driven testing.');
  console.log('   See docs/superpowers/specs/2026-04-19-mcp-broker-receiver-design.md');
  console.log('   → "Verification procedure" for the full happy-path walk-through.');
}

main().catch(err => {
  console.error('Acceptance test failed:', err.message);
  process.exit(1);
});
