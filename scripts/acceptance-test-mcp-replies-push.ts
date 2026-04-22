// scripts/acceptance-test-mcp-replies-push.ts
/**
 * MCP push-subscriptions acceptance test (reply-inbox side). Symmetric to
 * acceptance-test-mcp-push.ts but for the broker-reply path that lands
 * TaskResults in a broker-mode sender's inbox.
 *
 * Redis coverage:
 *   1. enqueueReply assigns monotonic seq starting at 1
 *   2. enqueueReply publishes to the reply-inbox-notify channel
 *   3. listReplies returns entries with seq populated
 *   4. forgetBrokerReplyAgent cleans up inbox + inflight + seq keys
 *
 * HTTP coverage:
 *   5. GET  /agents/:agentId/replies/stream without auth → 401
 *   6. GET  /agents/:agentId/replies/peek   without auth → 401
 *
 * Run:  npx tsx scripts/acceptance-test-mcp-replies-push.ts
 * Requires: Redis running locally (Nova a2a-server optional).
 */

import IORedis from 'ioredis';
import {
  enqueueReply,
  listReplies,
  forgetBrokerReplyAgent,
  replyInboxKey,
  replyInflightKey,
  replyInboxSeqKey,
  replyInboxNotifyChannel,
  taskResultKey,
  BROKER_REPLY_AGENTS_SET,
  ReplyInboxNotification,
} from '../packages/task-queue/src/reply-inbox';
import type { TaskResult } from '../packages/shared/src/types';

const A2A_URL = process.env.NOVA_URL ?? 'http://localhost:3001';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let passed = 0;
let failed = 0;

function check(name: string, condition: unknown, detail?: string): void {
  if (condition) {
    console.log(`  \u2713 ${name}`);
    passed += 1;
  } else {
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
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
  const tenantId = `t-reply-push-${Date.now()}`;
  const agentId = `a-reply-push-${Date.now()}`;
  const ctx = { tenantId, agentId };

  // Clean slate
  await redis.del(replyInboxKey(ctx), replyInflightKey(ctx), replyInboxSeqKey(ctx));
  await redis.srem(BROKER_REPLY_AGENTS_SET, `${tenantId}:${agentId}`);

  console.log('\nRedis coverage:');

  const sub = new IORedis(REDIS_URL);
  const received: ReplyInboxNotification[] = [];
  await sub.subscribe(replyInboxNotifyChannel(ctx));
  sub.on('message', (_channel, message) => {
    try { received.push(JSON.parse(message)); } catch { /* ignore */ }
  });
  await new Promise(r => setTimeout(r, 50));

  const taskId1 = '11111111-1111-1111-1111-111111111111';
  const taskId2 = '22222222-2222-2222-2222-222222222222';
  const r1 = mkResult(taskId1, { answer: 42 });
  const r2 = mkResult(taskId2, { answer: 43 });

  await enqueueReply(ctx, taskId1, r1);
  await enqueueReply(ctx, taskId2, r2);

  await new Promise(r => setTimeout(r, 100));

  check('notify channel received 2 events', received.length === 2, `got ${received.length}`);
  if (received[0]) {
    assertEq('first notification seq = 1', received[0].seq, 1);
    assertEq('first notification taskId', received[0].taskId, taskId1);
    check('first notification enqueuedAt is ISO', typeof received[0].enqueuedAt === 'string' && received[0].enqueuedAt.endsWith('Z'));
  }
  if (received[1]) {
    assertEq('second notification seq = 2', received[1].seq, 2);
    assertEq('second notification taskId', received[1].taskId, taskId2);
  }

  await sub.unsubscribe(replyInboxNotifyChannel(ctx));
  await sub.quit();

  const entries = await listReplies(ctx);
  assertEq('listReplies returns 2 entries', entries.length, 2);
  if (entries[0]) {
    assertEq('list head is most recent (t2)', entries[0].taskId, taskId2);
    assertEq('list head seq = 2', entries[0].seq, 2);
  }
  if (entries[1]) {
    assertEq('list tail is oldest (t1)', entries[1].taskId, taskId1);
    assertEq('list tail seq = 1', entries[1].seq, 1);
  }

  const seqBefore = await redis.get(replyInboxSeqKey(ctx));
  check('seq key exists pre-cleanup', seqBefore === '2');
  await forgetBrokerReplyAgent(ctx);
  const seqAfter = await redis.get(replyInboxSeqKey(ctx));
  check('seq key cleared by forgetBrokerReplyAgent', seqAfter === null);
  const listAfter = await listReplies(ctx);
  assertEq('reply inbox cleared by forgetBrokerReplyAgent', listAfter.length, 0);

  // Stored-result TTL keys are independent of the inbox list — we wrote two,
  // forgetBrokerReplyAgent doesn't touch them, so direct lookup still works.
  // Clean them up manually to leave the test tenant pristine.
  await redis.del(taskResultKey(ctx, taskId1), taskResultKey(ctx, taskId2));
}

async function runHttpCoverage(): Promise<void> {
  console.log('\nHTTP coverage:');

  try {
    const probe = await fetch(`${A2A_URL}/health`);
    if (probe.status >= 500) {
      console.log(`  \u00b7 a2a-server at ${A2A_URL} returned ${probe.status}; skipping HTTP coverage`);
      return;
    }
  } catch (err: any) {
    console.log(`  \u00b7 a2a-server at ${A2A_URL} not reachable (${err.code ?? err.message}); skipping HTTP coverage`);
    return;
  }

  const fakeAgent = 'non-existent-agent-mcp-replies-push';

  const peekRes = await fetch(`${A2A_URL}/agents/${fakeAgent}/replies/peek`);
  assertEq('GET /replies/peek without auth \u2192 401', peekRes.status, 401);

  const streamRes = await fetch(`${A2A_URL}/agents/${fakeAgent}/replies/stream`);
  assertEq('GET /replies/stream without auth \u2192 401', streamRes.status, 401);
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
  console.log('  \u2022 Two broker-mode agents: A and B.');
  console.log('  \u2022 B subscribes to nova://replies (nova_watch_replies).');
  console.log('  \u2022 B sends a task to A, omits replyTo.');
  console.log('  \u2022 A responds via nova_respond.');
  console.log('  \u2022 B sees an MCP notifications/resources/updated for nova://replies within ~100ms.');
  console.log('  \u2022 nova_next_reply returns immediately (reply at head of inbox).');
}

main().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
