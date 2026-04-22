// scripts/acceptance-test-mcp-push.ts
/**
 * MCP push-subscriptions acceptance test (inbox side).
 *
 * Exercises the enqueue → notify channel + list() primitives directly against
 * Redis, plus the new HTTP routes (401 coverage). Identity / MCP end-to-end
 * coverage is documented at the bottom as a manual happy path — same
 * precedent as acceptance-test-broker and acceptance-test-broker-reply.
 *
 * Redis coverage:
 *   1. enqueue assigns monotonic seq starting at 1
 *   2. enqueue publishes to the inbox-notify channel with the expected payload
 *   3. list() returns entries with seq populated
 *   4. forgetBrokerAgent cleans up inbox + inflight + seq keys
 *
 * HTTP coverage:
 *   5. GET  /agents/:agentId/inbox/stream without auth → 401
 *   6. GET  /agents/:agentId/inbox/peek   without auth → 401
 *
 * Run:  npx tsx scripts/acceptance-test-mcp-push.ts
 * Requires: Redis running locally (Nova a2a-server optional).
 */

import IORedis from 'ioredis';
import {
  enqueue,
  list,
  forgetBrokerAgent,
  inboxKey,
  inflightKey,
  inboxSeqKey,
  inboxNotifyChannel,
  BROKER_AGENTS_SET,
  InboxNotification,
} from '../packages/task-queue/src/inbox';
import type { QueuedTask } from '../packages/shared/src/types';

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

function mkTask(taskId: string, ctx: { tenantId: string; agentId: string }, intent: string): QueuedTask {
  const now = new Date();
  const expires = new Date(now.getTime() + 60_000);
  return {
    taskId,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    intent,
    params: { q: 'ping' },
    senderDid: 'did:key:zTestSender',
    tier: 1,
    queuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    schemaVersion: '1.0',
  } as unknown as QueuedTask;
}

async function runRedisCoverage(redis: IORedis): Promise<void> {
  const tenantId = `t-push-${Date.now()}`;
  const agentId = `a-push-${Date.now()}`;
  const ctx = { tenantId, agentId };

  // Clean slate
  await redis.del(inboxKey(ctx), inflightKey(ctx), inboxSeqKey(ctx));
  await redis.srem(BROKER_AGENTS_SET, `${tenantId}:${agentId}`);

  console.log('\nRedis coverage:');

  // 1 + 2: subscribe to the notify channel before enqueue so we can assert the
  // publish happened. Use a dedicated subscriber client.
  const sub = new IORedis(REDIS_URL);
  const received: InboxNotification[] = [];
  await sub.subscribe(inboxNotifyChannel(ctx));
  sub.on('message', (_channel, message) => {
    try { received.push(JSON.parse(message)); } catch { /* ignore */ }
  });
  // Give ioredis a tick to attach the subscription before publishing.
  await new Promise(r => setTimeout(r, 50));

  const t1 = mkTask('11111111-1111-1111-1111-111111111111', ctx, 'chat');
  const t2 = mkTask('22222222-2222-2222-2222-222222222222', ctx, 'dev_assist');

  await enqueue(ctx, t1);
  await enqueue(ctx, t2);

  // Wait briefly for pub/sub delivery.
  await new Promise(r => setTimeout(r, 100));

  check('notify channel received 2 events', received.length === 2, `got ${received.length}`);
  if (received[0]) {
    assertEq('first notification seq = 1', received[0].seq, 1);
    assertEq('first notification taskId', received[0].taskId, t1.taskId);
    assertEq('first notification intent', received[0].intent, 'chat');
    check('first notification enqueuedAt is ISO', typeof received[0].enqueuedAt === 'string' && received[0].enqueuedAt.endsWith('Z'));
  }
  if (received[1]) {
    assertEq('second notification seq = 2', received[1].seq, 2);
    assertEq('second notification taskId', received[1].taskId, t2.taskId);
  }

  await sub.unsubscribe(inboxNotifyChannel(ctx));
  await sub.quit();

  // 3: list() returns entries with seq populated. LPUSH means newest-first.
  const entries = await list(ctx);
  assertEq('list returns 2 entries', entries.length, 2);
  if (entries[0]) {
    assertEq('list head is most recent (t2)', entries[0].taskId, t2.taskId);
    assertEq('list head seq = 2', entries[0].seq, 2);
  }
  if (entries[1]) {
    assertEq('list tail is oldest (t1)', entries[1].taskId, t1.taskId);
    assertEq('list tail seq = 1', entries[1].seq, 1);
  }

  // 4: forgetBrokerAgent cleans up seq key too.
  const seqBefore = await redis.get(inboxSeqKey(ctx));
  check('seq key exists pre-cleanup', seqBefore === '2');
  await forgetBrokerAgent(ctx);
  const seqAfter = await redis.get(inboxSeqKey(ctx));
  check('seq key cleared by forgetBrokerAgent', seqAfter === null);
  const listAfter = await list(ctx);
  assertEq('inbox cleared by forgetBrokerAgent', listAfter.length, 0);
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

  const fakeAgent = 'non-existent-agent-mcp-push';

  const peekRes = await fetch(`${A2A_URL}/agents/${fakeAgent}/inbox/peek`);
  assertEq('GET /inbox/peek without auth \u2192 401', peekRes.status, 401);

  const streamRes = await fetch(`${A2A_URL}/agents/${fakeAgent}/inbox/stream`);
  assertEq('GET /inbox/stream without auth \u2192 401', streamRes.status, 401);
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
  console.log('  \u2022 Start Nova (docker-compose up) and an MCP client with NOVA_AGENT_ID set.');
  console.log('  \u2022 From the client: subscribe to nova://inbox (or call nova_watch_inbox).');
  console.log('  \u2022 Send a task to this agent from a second identity.');
  console.log('  \u2022 Expect an MCP notifications/resources/updated for nova://inbox within ~100ms.');
  console.log('  \u2022 nova_next_task should return the task immediately (already at inbox head).');
  console.log('  \u2022 Disconnect the MCP session mid-burst; send N more tasks; reconnect.');
  console.log('  \u2022 The replay path should re-surface the N missed tasks (seq > Last-Event-ID).');
}

main().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
