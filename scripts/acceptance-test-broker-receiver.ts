// scripts/acceptance-test-broker-receiver.ts
/**
 * End-to-end acceptance test for the broker-receiver daemon.
 *
 * What this covers (automated):
 *   1. Onboarding via `broker-receiver init` — mint invite, register,
 *      approve (concurrently), poll /register/status, claim grant.
 *   2. Daemon lifecycle — spawn `broker-receiver run`, wait for /health,
 *      assert the handler is wired and the pull loop is running.
 *   3. Steady state — leave the daemon running ~4s with no work, assert
 *      zero pull errors accumulate (catches UCAN / DID indexing bugs).
 *   4. Graceful shutdown — SIGTERM the daemon, assert clean exit within
 *      the grace window.
 *
 * Task round-trip is a manual smoke test (documented below). Driving
 * end-to-end delivery from a host-side test script is complicated by
 * dev-environment redis topology — docker-compose's `nova-redis-1` and
 * a host brew-installed redis can race for 127.0.0.1:6379, making
 * host-side `task-queue.enqueue` target the wrong Redis. Rather than
 * ship a flaky test, the round-trip is exercised by the manual script
 * at the bottom (send a task from a peer identity via `nova_send_task`
 * and observe the daemon respond).
 *
 * Run: npx tsx scripts/acceptance-test-broker-receiver.ts
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fsp from 'fs/promises';
import os from 'os';
import { request } from 'undici';

const A2A_URL = process.env.NOVA_URL ?? 'http://localhost:3001';
const ADMIN_URL = process.env.NOVA_ADMIN_URL ?? 'http://127.0.0.1:3005';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? process.env.NOVA_ADMIN_TOKEN ?? 'my-secure-admin-token-12345';
const RECEIVER_AGENT_ID = process.env.RECEIVER_AGENT_ID ?? `test-receiver-${Date.now()}`;
const TENANT_ID = process.env.TENANT_ID ?? 'tenant_496bdb38306a';

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

async function mintInvite(agentIdHint: string): Promise<string> {
  const res = await request(`${ADMIN_URL}/admin/tenants/${TENANT_ID}/invites`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agentIdHint, ttlSeconds: 600 }),
  });
  const text = await res.body.text();
  if (res.statusCode !== 201 && res.statusCode !== 200) {
    throw new Error(`mintInvite ${res.statusCode}: ${text}`);
  }
  return JSON.parse(text).token;
}

async function approve(agentId: string): Promise<void> {
  const res = await request(`${ADMIN_URL}/admin/tenants/${TENANT_ID}/agents/${agentId}/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ trustTier: 2 }),
  });
  const text = await res.body.text();
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`approve ${res.statusCode}: ${text}`);
  }
}

async function waitForHealth(healthUrl: string, timeoutMs = 15_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      const body = await res.json() as any;
      if (res.status === 200 && body.status === 'ok') return body;
      lastErr = body;
    } catch (err) { lastErr = err; }
    await sleep(200);
  }
  throw new Error(`health never became ok: ${JSON.stringify(lastErr)}`);
}

async function onboard(): Promise<void> {
  console.log('\nOnboarding receiver:');
  const invite = await mintInvite(RECEIVER_AGENT_ID);
  check('mintInvite returned a token', typeof invite === 'string' && invite.length > 40);

  const initProc = spawn(
    'npx',
    [
      'tsx',
      path.resolve(__dirname, '../packages/broker-receiver/src/cli.ts'),
      'init',
      '--agent-id', RECEIVER_AGENT_ID,
      '--invite', invite,
      '--nova-url', A2A_URL,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  initProc.stderr.on('data', (d) => process.stderr.write(`    [init] ${d}`));

  const initDone = new Promise<void>((resolve, reject) => {
    initProc.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`init exited with code ${code}`));
    });
    initProc.on('error', reject);
  });

  // Approve once the agent shows up in /register/status.
  const deadline = Date.now() + 30_000;
  let registeredSeen = false;
  while (!registeredSeen && Date.now() < deadline) {
    const res = await fetch(`${A2A_URL}/register/status/${TENANT_ID}/${RECEIVER_AGENT_ID}`);
    if (res.status === 200) {
      const body = await res.json() as any;
      if (body.status === 'pending' || body.status === 'active') {
        registeredSeen = true;
        break;
      }
    }
    await sleep(200);
  }
  check('register made the agent visible in /register/status', registeredSeen);

  await approve(RECEIVER_AGENT_ID);
  check('approve succeeded', true);

  await initDone;
  check('init exited 0 after approval + grant claim', true);
}

async function runDaemonAndProbe(): Promise<void> {
  const healthPort = 40_000 + Math.floor(Math.random() * 20_000);
  const daemon = spawn(
    'npx',
    [
      'tsx',
      path.resolve(__dirname, '../packages/broker-receiver/src/cli.ts'),
      'run',
      '--agent-id', RECEIVER_AGENT_ID,
      '--nova-url', A2A_URL,
      '--handler', 'echo',
      '--health-port', String(healthPort),
      '--poll-wait-ms', '2000',
      '--shutdown-grace-seconds', '5',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  daemon.stderr.on('data', (d) => process.stderr.write(`    [daemon] ${d}`));

  let daemonExited = false;
  let daemonExitCode: number | null = null;
  daemon.once('exit', (code) => {
    daemonExited = true;
    daemonExitCode = code;
  });

  try {
    console.log('\nDaemon lifecycle:');
    const healthy = await waitForHealth(`http://127.0.0.1:${healthPort}/health`, 20_000);
    check('daemon /health reports status=ok', healthy.status === 'ok');
    check('daemon /health reports echo handler', healthy.handler === 'echo');
    check('daemon /health reports agentId', healthy.agentId === RECEIVER_AGENT_ID);
    check('pull loop running', healthy.pullLoop.running === true);
    check('dispatcher inFlight=0 at startup', healthy.dispatcher.inFlight === 0);

    console.log('\nSteady state (4s):');
    await sleep(4_000);
    const snapshot = await fetch(`http://127.0.0.1:${healthPort}/health`).then(r => r.json()) as any;
    check('pull loop still running after 4s', snapshot.pullLoop.running === true);
    assertEq('zero pull errors accumulated', snapshot.pullLoop.totalPullErrors, 0);
    assertEq('zero consecutive errors', snapshot.pullLoop.consecutiveErrors, 0);
    check('at least one pull attempted (2s poll)', snapshot.pullLoop.totalPulls >= 1);

    console.log('\nShutdown:');
    daemon.kill('SIGTERM');
    const exitDeadline = Date.now() + 15_000;
    while (!daemonExited && Date.now() < exitDeadline) {
      await sleep(100);
    }
    check('daemon exited within 15s of SIGTERM', daemonExited);
    check('daemon exit code 0', daemonExitCode === 0);
  } finally {
    if (!daemonExited) {
      daemon.kill('SIGKILL');
    }
  }
}

async function cleanup(): Promise<void> {
  const idPath = path.join(os.homedir(), '.nova', 'agents', `${RECEIVER_AGENT_ID}.json`);
  await fsp.unlink(idPath).catch(() => {});
}

async function main(): Promise<void> {
  try {
    const probe = await fetch(`${A2A_URL}/health`);
    if (probe.status >= 500) {
      console.log(`  \u00b7 a2a-server at ${A2A_URL} returned ${probe.status}; skipping`);
      return;
    }
  } catch (err: any) {
    console.log(`  \u00b7 a2a-server at ${A2A_URL} not reachable (${err.code ?? err.message}); skipping`);
    return;
  }

  try {
    await onboard();
    await runDaemonAndProbe();
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

  console.log('\nManual task round-trip (not automated):');
  console.log('  \u2022 Register a second agent (or reuse claude-code) on the same tenant.');
  console.log(`  \u2022 From that agent, nova_send_task targeted at ${RECEIVER_AGENT_ID} with intent=chat.`);
  console.log('  \u2022 The running daemon (echo handler) should respond within one poll window (~2s).');
  console.log('  \u2022 The sender should observe the reply via nova_next_reply (broker-mode)');
  console.log('    or via its replyUrl (webhook-mode).');
  console.log('  \u2022 /health on the daemon should show dispatcher.totalResponded incremented.');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
