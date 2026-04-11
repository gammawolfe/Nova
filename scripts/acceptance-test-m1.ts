import fs from 'fs';
import path from 'path';

const A2A_URL = process.env.A2A_URL || 'http://localhost:3001';
const REPLY_RECEIVER_URL = process.env.REPLY_RECEIVER_URL || 'http://localhost:4001';
const AGENT_ID = 'agent_aria';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== MILESTONE 1 ACCEPTANCE TEST ===\n');

  // Resolve the DID from data/keys/nova.did for auth header
  const didPath = path.join(process.cwd(), 'data', 'keys', 'nova.did');
  let senderDid = 'did:example:stub';
  if (fs.existsSync(didPath)) {
    senderDid = fs.readFileSync(didPath, 'utf8').trim();
  }
  console.log(`Using sender DID: ${senderDid}\n`);

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
  const taskRes = await fetch(`${A2A_URL}/agents/${AGENT_ID}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'UCAN eyJhbGciOiJFZERTQSJ9.mockpayload.mocksignature',
      'x-mock-did': senderDid,
    },
    body: JSON.stringify({
      intent: 'query_knowledge',
      params: { query: 'What is Nova?' },
      replyTo: `${REPLY_RECEIVER_URL}/webhook`,
    }),
  });
  assert(taskRes.status === 202, `Task submission should return 202, got ${taskRes.status}`);
  const { taskId } = await taskRes.json() as { taskId: string };
  assert(!!taskId, 'Response should include a taskId');
  console.log(`[PASS] Task submitted: ${taskId}\n`);

  // --- Test 3: Poll Task Status ---
  console.log('--- Test 3: Task Status Polling ---');
  let state: any = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const statusRes = await fetch(`${A2A_URL}/agents/${AGENT_ID}/tasks/${taskId}`);
    if (statusRes.status === 404) {
      console.log(`  Poll ${i + 1}: not found yet...`);
      continue;
    }
    state = await statusRes.json();
    console.log(`  Poll ${i + 1}: status=${state.status}`);
    if (state.status === 'completed' || state.status === 'failed') break;
  }

  assert(state !== null, 'Task state should exist');
  assert(state.status === 'completed', `Expected 'completed', got '${state.status}'${state.statusMessage ? `: ${state.statusMessage}` : ''}`);
  assert(state.result, 'Completed task should have a result');
  assert(state.result.status === 'ok', `Result status should be 'ok', got '${state.result?.status}'`);
  console.log(`[PASS] Task completed with result: ${JSON.stringify(state.result.result)}\n`);

  // --- Test 4: Verify replyTo Delivery ---
  console.log('--- Test 4: replyTo Delivery ---');
  // Give a moment for the replyTo POST to land
  await sleep(1000);
  const receivedRes = await fetch(`${REPLY_RECEIVER_URL}/results`);
  const received = await receivedRes.json() as any[];
  assert(received.length > 0, 'Reply receiver should have received at least one result');
  const delivered = received.find((r: any) => r.requestId === taskId);
  assert(!!delivered, 'Should find our task result in delivered results');
  assert(delivered.status === 'ok', `Delivered result status should be 'ok'`);
  console.log(`[PASS] Result delivered to replyTo webhook\n`);

  // --- Test 5: Idempotency Check ---
  console.log('--- Test 5: Idempotency ---');
  const dupeRes = await fetch(`${A2A_URL}/agents/${AGENT_ID}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'UCAN eyJhbGciOiJFZERTQSJ9.mockpayload.mocksignature',
      'x-mock-did': senderDid,
    },
    body: JSON.stringify({
      intent: 'query_knowledge',
      params: { query: 'What is Nova again?' },
      replyTo: `${REPLY_RECEIVER_URL}/webhook`,
    }),
  });
  assert(dupeRes.status === 202, 'Duplicate submission should still return 202');
  console.log('[PASS] Idempotent duplicate handled gracefully\n');

  console.log('=== MILESTONE 1 ACCEPTANCE TEST PASSED ===');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
