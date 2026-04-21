// scripts/acceptance-test-broker-reply.ts
/**
 * Broker-reply inbox acceptance test.
 *
 * Exercises the reply-inbox module directly against Redis plus the new HTTP
 * routes on a2a-server. Identity / UCAN setup for the full MCP-driven happy
 * path is documented at the bottom — same precedent as acceptance-test-broker.
 *
 * Redis coverage:
 *   1. enqueueReply → pullReply round-trip
 *   2. Stored TaskResult lookup via getStoredResult
 *   3. Ack clears in-flight; second ack is idempotent
 *   4. Stored result survives the ack (direct-lookup is TTL-only)
 *   5. Reclaim redelivers expired in-flight entries
 *   6. Reclaim DLQs past the ceiling
 *
 * HTTP coverage:
 *   7. GET  /agents/:agentId/replies without auth  → 401
 *   8. GET  /agents/:agentId/replies/:taskId w/o auth → 401
 *   9. POST /agents/:agentId/replies/:taskId/ack w/o auth → 401
 *
 * Run:  npx tsx scripts/acceptance-test-broker-reply.ts
 * Requires: Nova running locally (docker-compose up).
 */

import IORedis from 'ioredis';
import * as replyInbox from '../packages/task-queue/src/reply-inbox';
import type { TaskResult } from '../packages/shared/src/types';

const A2A_URL = process.env.NOVA_URL ?? 'http://localhost:3001';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let passed = 0;
let failed = 0;

function check(name: string, condition: unknown, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

function assertEq(name: string, actual: unknown, expected: unknown): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, match, match ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function mkResult(taskId: string, payload: Record<string, unknown>): TaskResult {
  return {
    type: 'TaskResult',
    requestId: taskId,
    status: 'ok',
    result: payload,
    auditToken: 'none',
    completedAt: new Date().toISOString(),
    schemaVersion: '1.0',
  };
}

async function runRedisCoverage(redis: IORedis): Promise<void> {
  const tenantId = `t-reply-${Date.now()}`;
  const agentId = `a-reply-${Date.now()}`;
  const ctx = { tenantId, agentId };

  // Clean slate — these keys shouldn't exist, but be defensive.
  await redis.del(
    replyInbox.replyInboxKey(ctx),
    replyInbox.replyInflightKey(ctx),
  );

  console.log('\nRedis coverage:');

  // 1. enqueue + pull round-trip
  const taskId1 = '11111111-1111-1111-1111-111111111111';
  const result1 = mkResult(taskId1, { answer: 42 });
  await replyInbox.enqueueReply(ctx, taskId1, result1);
  const pulled1 = await replyInbox.pullReply(ctx, 1000);
  check('enqueue → pull returns the reply', pulled1 !== null);
  assertEq('pulled taskId matches', pulled1?.taskId, taskId1);
  assertEq('pulled result matches', pulled1?.result, result1);

  // 2. Stored result is retrievable via getStoredResult
  const stored1 = await replyInbox.getStoredResult(ctx, taskId1);
  assertEq('getStoredResult returns the same result', stored1, result1);

  // 3. Ack clears in-flight; second ack is idempotent
  const ack1a = await replyInbox.ackReply(ctx, taskId1);
  assertEq('first ack → accepted', ack1a, 'accepted');
  const ack1b = await replyInbox.ackReply(ctx, taskId1);
  assertEq('second ack → reply_not_found', ack1b, 'reply_not_found');

  // 4. Stored result survives the ack — ack clears in-flight only.
  const stored1AfterAck = await replyInbox.getStoredResult(ctx, taskId1);
  assertEq('stored result persists past ack', stored1AfterAck, result1);

  // 5. Reclaim redelivers an expired in-flight entry.
  const taskId2 = '22222222-2222-2222-2222-222222222222';
  const result2 = mkResult(taskId2, { note: 'reclaim-me' });
  await replyInbox.enqueueReply(ctx, taskId2, result2);
  await replyInbox.pullReply(ctx, 1000); // claim it

  // Backdate the in-flight score so reclaim considers it expired.
  const inflightRaws = await redis.zrange(replyInbox.replyInflightKey(ctx), 0, -1);
  check('in-flight entry exists before reclaim', inflightRaws.length === 1);
  if (inflightRaws[0]) {
    await redis.zadd(replyInbox.replyInflightKey(ctx), 1, inflightRaws[0]);
  }

  const reclaim1 = await replyInbox.reclaimReplies(ctx);
  assertEq('reclaim redelivered one entry', reclaim1.redelivered, 1);
  assertEq('reclaim dead-lettered none', reclaim1.deadLettered, 0);

  // 6. Reclaim ceiling → DLQ (default ceiling is 3; simulate by forcing count).
  const pulled2b = await replyInbox.pullReply(ctx, 1000);
  check('redelivered entry is pullable', pulled2b !== null);
  const raws2 = await redis.zrange(replyInbox.replyInflightKey(ctx), 0, -1);
  if (raws2[0]) {
    // Bump reclaimCount to one short of the ceiling and backdate visibility.
    const entry = JSON.parse(raws2[0]);
    entry.reclaimCount = 10; // safely past BROKER_RECLAIM_CEILING default 3
    await redis.zrem(replyInbox.replyInflightKey(ctx), raws2[0]);
    await redis.zadd(replyInbox.replyInflightKey(ctx), 1, JSON.stringify(entry));
  }
  const reclaim2 = await replyInbox.reclaimReplies(ctx);
  assertEq('reclaim past ceiling dead-letters', reclaim2.deadLettered, 1);

  // Cleanup
  await redis.del(
    replyInbox.replyInboxKey(ctx),
    replyInbox.replyInflightKey(ctx),
    replyInbox.taskResultKey(ctx, taskId1),
    replyInbox.taskResultKey(ctx, taskId2),
  );
  await redis.srem(replyInbox.BROKER_REPLY_AGENTS_SET, `${tenantId}:${agentId}`);
}

async function runHttpCoverage(): Promise<void> {
  console.log('\nHTTP coverage:');

  // Probe a2a-server liveness; skip gracefully if unreachable so the Redis
  // half of this script is useful in partial-stack environments.
  try {
    const probe = await fetch(`${A2A_URL}/health`);
    if (probe.status >= 500) {
      console.log(`  · a2a-server at ${A2A_URL} returned ${probe.status}; skipping HTTP coverage`);
      return;
    }
  } catch (err: any) {
    console.log(`  · a2a-server at ${A2A_URL} not reachable (${err.code ?? err.message}); skipping HTTP coverage`);
    return;
  }

  const fakeAgent = 'non-existent-agent';

  const pullRes = await fetch(`${A2A_URL}/agents/${fakeAgent}/replies?wait=0`);
  assertEq('GET /replies without auth → 401', pullRes.status, 401);

  const lookupRes = await fetch(`${A2A_URL}/agents/${fakeAgent}/replies/deadbeef-1234-5678-9abc-deadbeef0001`);
  assertEq('GET /replies/:taskId without auth → 401', lookupRes.status, 401);

  const ackRes = await fetch(`${A2A_URL}/agents/${fakeAgent}/replies/deadbeef-1234-5678-9abc-deadbeef0001/ack`, {
    method: 'POST',
  });
  assertEq('POST /replies/:taskId/ack without auth → 401', ackRes.status, 401);
}

async function main(): Promise<void> {
  const redis = new IORedis(REDIS_URL);

  try {
    await runRedisCoverage(redis);
    await runHttpCoverage();
  } finally {
    await redis.quit();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

  console.log('\nFull MCP-driven happy path (manual):');
  console.log('  • Register two broker-mode agents (no operatorUrl) across two MCP sessions.');
  console.log('  • Sender: nova_send_task → recipient (omit replyTo).');
  console.log('  • Recipient: nova_next_task → nova_respond (status: ok).');
  console.log('  • Sender: nova_next_reply — expect the TaskResult payload.');
  console.log('  • Sender: nova_ack_reply — expect { status: "accepted" }.');
  console.log('  • Sender: nova_get_task_result — expect { source: "broker_reply", ... }.');
}

main().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
