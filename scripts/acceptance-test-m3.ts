/**
 * Milestone 3 — Operational Acceptance Test
 *
 * Prerequisites:
 *   - Redis running on localhost:6379
 *   - Admin API running on localhost:3005
 *   - A2A server running on localhost:3001
 *   - ADMIN_TOKEN env var set (default matches .env.example)
 */

const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:3005';
const A2A_URL = process.env.A2A_URL || 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token-replace-before-prod-use';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function main() {
  console.log('=== MILESTONE 3 ACCEPTANCE TEST ===\n');

  // --- Test 1: Create Tenant via Admin API ---
  console.log('--- Test 1: Create Tenant ---');
  const tenantRes = await adminFetch('/admin/tenants', {
    method: 'POST',
    body: JSON.stringify({ name: 'M3 Test Org', slug: 'm3-test-org', plan: 'developer' }),
  });
  assert(tenantRes.status === 201, `Create tenant should return 201, got ${tenantRes.status}`);
  const tenant = await tenantRes.json() as any;
  assert(!!tenant.id, 'Tenant should have an ID');
  assert(tenant.status === 'active', 'Tenant should be active');
  console.log(`[PASS] Tenant created: ${tenant.id}\n`);

  // --- Test 2: Register Agent with highPrivilegeSkills ---
  console.log('--- Test 2: Register Agent ---');
  const agentRes = await adminFetch(`/admin/tenants/${tenant.id}/agents`, {
    method: 'POST',
    body: JSON.stringify({
      agentId: 'agent_m3_test',
      name: 'M3 Test Agent',
      description: 'Test agent for M3 acceptance',
      skills: [
        { id: 'query_data', name: 'Query Data', description: 'Read-only data query' },
        { id: 'delete_data', name: 'Delete Data', description: 'Dangerous delete operation' },
      ],
      highPrivilegeSkills: ['delete_data'],
      confirmTimeouts: { delete_data: 30 },
    }),
  });
  assert(agentRes.status === 201, `Register agent should return 201, got ${agentRes.status}`);
  const agent = await agentRes.json() as any;
  assert(agent.agentId === 'agent_m3_test', 'Agent ID mismatch');
  assert(agent.highPrivilegeSkills.includes('delete_data'), 'Should have highPrivilegeSkills');
  console.log(`[PASS] Agent registered: ${agent.agentId}\n`);

  // --- Test 3: Add Trust Record ---
  console.log('--- Test 3: Add Trust Record ---');
  const testDid = 'did:key:z6MkTestAcceptanceM3';
  const trustRes = await adminFetch(`/admin/tenants/${tenant.id}/agents/agent_m3_test/trust`, {
    method: 'POST',
    body: JSON.stringify({
      did: testDid,
      displayName: 'M3 Test Actor',
      tier: 2,
      allowedSkills: ['query_data', 'delete_data'],
    }),
  });
  assert(trustRes.status === 201, `Add trust should return 201, got ${trustRes.status}`);
  console.log(`[PASS] Trust record added for ${testDid}\n`);

  // --- Test 4: List Tenants ---
  console.log('--- Test 4: List Tenants ---');
  const listRes = await adminFetch('/admin/tenants');
  assert(listRes.status === 200, 'List tenants should return 200');
  const tenants = await listRes.json() as any[];
  assert(tenants.some((t: any) => t.id === tenant.id), 'Created tenant should appear in list');
  console.log(`[PASS] ${tenants.length} tenant(s) listed\n`);

  // --- Test 5: List Agents ---
  console.log('--- Test 5: List Agents ---');
  const agentsListRes = await adminFetch(`/admin/tenants/${tenant.id}/agents`);
  assert(agentsListRes.status === 200, 'List agents should return 200');
  const agents = await agentsListRes.json() as any[];
  assert(agents.length >= 1, 'Should have at least 1 agent');
  console.log(`[PASS] ${agents.length} agent(s) listed\n`);

  // --- Test 6: Quarantine Stats ---
  console.log('--- Test 6: Quarantine Stats ---');
  const statsRes = await adminFetch(`/admin/tenants/${tenant.id}/agents/agent_m3_test/quarantine/stats`);
  assert(statsRes.status === 200, 'Quarantine stats should return 200');
  const stats = await statsRes.json() as any;
  assert(typeof stats.total === 'number', 'Stats should have total');
  console.log(`[PASS] Quarantine stats: ${JSON.stringify(stats)}\n`);

  // --- Test 7: Health Endpoints ---
  console.log('--- Test 7: Health Endpoints ---');

  const a2aHealthRes = await fetch(`${A2A_URL}/health`);
  assert(a2aHealthRes.status === 200, `A2A health should return 200, got ${a2aHealthRes.status}`);
  const a2aHealth = await a2aHealthRes.json() as any;
  assert(a2aHealth.service === 'a2a-server', 'A2A health service name mismatch');
  assert(typeof a2aHealth.checks === 'object', 'A2A health should have checks');
  console.log(`[PASS] A2A server health: ${a2aHealth.status}\n`);

  // --- Test 8: Metrics Endpoint ---
  console.log('--- Test 8: Metrics Endpoint ---');
  const metricsRes = await fetch(`${A2A_URL}/metrics`);
  assert(metricsRes.status === 200, 'Metrics should return 200');
  const metricsText = await metricsRes.text();
  assert(metricsText.includes('nova_active_sse_streams'), 'Metrics should include SSE gauge');
  console.log(`[PASS] Prometheus metrics available (${metricsText.length} bytes)\n`);

  // --- Test 9: Audit Query ---
  console.log('--- Test 9: Audit Query ---');
  const auditRes = await adminFetch(`/admin/tenants/${tenant.id}/audit`);
  assert(auditRes.status === 200, 'Audit query should return 200');
  const audit = await auditRes.json() as any;
  assert(typeof audit.total === 'number', 'Audit should have total');
  console.log(`[PASS] Audit log: ${audit.total} events\n`);

  // --- Test 10: Admin Aggregated Health ---
  console.log('--- Test 10: Admin Health ---');
  const adminHealthRes = await adminFetch('/admin/health');
  assert(adminHealthRes.status === 200 || adminHealthRes.status === 503, 'Admin health should return 200 or 503');
  const adminHealth = await adminHealthRes.json() as any;
  assert(adminHealth.service === 'admin-api', 'Admin health service name mismatch');
  assert(typeof adminHealth.checks === 'object', 'Admin health should have checks');
  console.log(`[PASS] Admin aggregated health: ${adminHealth.status}`);
  for (const [name, check] of Object.entries(adminHealth.checks)) {
    console.log(`  ${name}: ${(check as any).status}`);
  }
  console.log('');

  // --- Test 11: Auth Enforcement ---
  console.log('--- Test 11: Auth Enforcement ---');
  const unauthRes = await fetch(`${ADMIN_URL}/admin/tenants`);
  assert(unauthRes.status === 401, `Unauthenticated request should return 401, got ${unauthRes.status}`);
  console.log('[PASS] Unauthorized access properly blocked\n');

  // --- Cleanup: Soft-delete test tenant ---
  console.log('--- Cleanup ---');
  await adminFetch(`/admin/tenants/${tenant.id}`, { method: 'DELETE' });
  console.log(`Soft-deleted test tenant: ${tenant.id}\n`);

  console.log('=== ALL M3 ACCEPTANCE TESTS PASSED ===');
}

main().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
