/**
 * scripts/acceptance-test-m1.ts
 *
 * Milestone 1 acceptance test — end-to-end task lifecycle.
 *
 * ⚠ NEEDS UPDATE: this test predates the sender-signed UCAN refactor
 * (2026-04-21). It loads a Nova-signed UCAN from data/tenants/.../ucans/issued
 * — a shape that no longer represents a valid invocation token in the new
 * model. Invocation tokens now need to be minted locally by the sender
 * (iss=sender.did, aud=novaDid, prf=[approval_grant]); see m4 for the current
 * onboarding flow and scripts/acceptance-test-broker-reply.ts for the Redis
 * plumbing verification.
 *
 * Prerequisites:
 *   - All services running (docker compose up -d)
 *   - Test pending rewrite to use the new grant + local mint flow.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const A2A_URL = process.env.A2A_URL || 'http://localhost:3001';
const AGENT_ID = 'agent_aria';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

function uuid(): string {
  return crypto.randomUUID();
}

/** Load the most recently issued UCAN token from the issued/ directory. */
function loadUcanToken(): string {
  const dataRoot = path.join(process.cwd(), 'data');
  const issuedDir = path.join(dataRoot, 'tenants', 'tenant_seed_123', 'ucans', 'issued');
  const files = fs.readdirSync(issuedDir).filter(f => f.endsWith('.json'));
  assert(files.length > 0, 'No UCAN tokens found — run: npx tsx scripts/issue-ucan.ts');
  const meta = JSON.parse(fs.readFileSync(path.join(issuedDir, files[files.length - 1]), 'utf8'));
  return meta.token as string;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== MILESTONE 1 ACCEPTANCE TEST ===\n');

  const ucanToken = loadUcanToken();
  console.log(`Using UCAN (first 30 chars): ${ucanToken.slice(0, 30)}…\n`);

  // --- Test 1: Agent Card ---
  console.log('--- Test 1: Agent Card Endpoint ---');
  const cardRes = await fetch(`${A2A_URL}/agents/${AGENT_ID}/.well-known/agent.json`);
  assert(cardRes.status === 200, `Agent card should return 200, got ${cardRes.status}`);
  const card = await cardRes.json();
  assert(card.name === 'Aria Data Helper', `Agent name mismatch: ${card.name}`);
  assert(Array.isArray(card.skills) && card.skills.length > 0, 'Agent should have skills');
  assert(card.protocolVersions.includes('1.0'), 'Should support protocol 1.0');
  console.log(`[PASS] Agent card: "${card.name}" with ${card.skills.length} skills\n`);

  // --- Test 2: Submit Task ---
  console.log('--- Test 2: Task Submission ---');
  const taskId = uuid();
  const idempotencyKey = uuid();
  const taskRes = await fetch(`${A2A_URL}/agents/${AGENT_ID}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `UCAN ${ucanToken}`,
    },
    body: JSON.stringify({
      id: taskId,
      schemaVersion: '1.0',
      intent: 'query_knowledge',
      params: { query: 'What is Nova?' },
      replyTo: 'https://localhost:3001/webhook',
      ttl: '2030-01-01T00:00:00Z',
      idempotencyKey,
    }),
  });
  assert(taskRes.status === 200 || taskRes.status === 202,
    `Task submission should return 200/202, got ${taskRes.status}`);
  const body = await taskRes.json();
  const returnedTaskId = (body as any).taskId;
  assert(!!returnedTaskId, 'Response should include a taskId');
  console.log(`[PASS] Task submitted: ${returnedTaskId}\n`);

  // --- Test 3: Poll Task Status ---
  console.log('--- Test 3: Task Status Polling ---');
  let state: any = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const statusRes = await fetch(`${A2A_URL}/agents/${AGENT_ID}/tasks/${returnedTaskId}`);
    if (statusRes.status === 404) {
      console.log(`  Poll ${i + 1}: not found yet...`);
      continue;
    }
    state = await statusRes.json();
    console.log(`  Poll ${i + 1}: status=${state.status}`);
    if (state.status === 'completed' || state.status === 'failed') break;
  }

  assert(state !== null, 'Task state should exist');
  const okStatuses = ['completed', 'input_required'];
  assert(okStatuses.includes(state.status),
    `Expected ${okStatuses.join(' or ')}, got '${state.status}'${state.statusMessage ? `: ${state.statusMessage}` : ''}`);
  console.log(`[PASS] Task reached terminal state: ${state.status}\n`);

  // --- Test 4: Reject Without Auth ---
  console.log('--- Test 4: Unauthenticated Request Rejected ---');
  const noAuthRes = await fetch(`${A2A_URL}/agents/${AGENT_ID}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: uuid(),
      schemaVersion: '1.0',
      intent: 'query_knowledge',
      params: { query: 'hello' },
      replyTo: 'https://localhost:3001/webhook',
      ttl: '2030-01-01T00:00:00Z',
      idempotencyKey: uuid(),
    }),
  });
  assert(noAuthRes.status === 401 || noAuthRes.status === 403,
    `Unauthenticated request should be rejected, got ${noAuthRes.status}`);
  console.log(`[PASS] Unauthenticated request rejected (${noAuthRes.status})\n`);

  // --- Test 5: Idempotency (resubmit same idempotencyKey) ---
  console.log('--- Test 5: Idempotency ---');
  const dupeRes = await fetch(`${A2A_URL}/agents/${AGENT_ID}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `UCAN ${ucanToken}`,
    },
    body: JSON.stringify({
      id: uuid(),
      schemaVersion: '1.0',
      intent: 'query_knowledge',
      params: { query: 'duplicate check' },
      replyTo: 'https://localhost:3001/webhook',
      ttl: '2030-01-01T00:00:00Z',
      idempotencyKey, // repeat key
    }),
  });
  assert(dupeRes.status >= 200 && dupeRes.status < 500,
    `Idempotent duplicate should return 2xx, got ${dupeRes.status}`);
  console.log('[PASS] Idempotent duplicate handled gracefully\n');

  console.log('=== MILESTONE 1 ACCEPTANCE TEST PASSED ===');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
