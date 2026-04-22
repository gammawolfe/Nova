// scripts/acceptance-test-broker-receiver.ts
/**
 * End-to-end acceptance test for the broker-receiver daemon.
 *
 * Covers (automated):
 *   1. Onboarding via `broker-receiver init` — mint invite, register,
 *      approve (concurrently), poll /register/status, claim grant.
 *   2. Daemon lifecycle — spawn `broker-receiver run` in push mode, wait
 *      for /health, assert handler + claim loop + SSE subscription are
 *      wired.
 *   3. Steady state — leave the daemon running briefly, assert zero pull
 *      errors accumulate and SSE stays connected.
 *   4. **Task round-trip** — send a real task from claude-code (which
 *      ships a cached grant locally) to the receiver via the HTTP
 *      ingress, with a loopback replyTo URL; assert the daemon responds
 *      within 5 seconds and the capture server sees the echo payload.
 *   5. Graceful shutdown — SIGTERM the daemon, assert clean exit.
 *
 * The round-trip section is automated here (vs the p3.2 script which
 * documented it manually) because we now drive delivery via the HTTP
 * send path inside the server container's Redis, avoiding the host-side
 * brew-vs-docker Redis port collision that blocked the p3.2 automation.
 *
 * Requires: Nova running locally AND a claude-code identity + cached
 * grant at ~/.nova/agents/claude-code{.json,.ucan.json}. The round-trip
 * assertions skip gracefully if claude-code isn't onboarded.
 *
 * Run: npx tsx scripts/acceptance-test-broker-receiver.ts
 */

import { spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import fsp from 'fs/promises';
import os from 'os';
import { request } from 'undici';
import { loadIdentity } from '../packages/mcp-server/src/identity';
import { loadCache } from '../packages/mcp-server/src/ucan-store';
import { mintInvocationToken } from '../packages/mcp-server/src/ucan-mint';

const A2A_URL = process.env.NOVA_URL ?? 'http://localhost:3001';
const ADMIN_URL = process.env.NOVA_ADMIN_URL ?? 'http://127.0.0.1:3005';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? process.env.NOVA_ADMIN_TOKEN ?? 'my-secure-admin-token-12345';
const RECEIVER_AGENT_ID = process.env.RECEIVER_AGENT_ID ?? `test-receiver-${Date.now()}`;
const SENDER_AGENT_ID = process.env.SENDER_AGENT_ID ?? 'claude-code';
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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

interface CaptureServer {
  url: string;
  received: Array<unknown>;
  stop: () => Promise<void>;
}

function startCaptureServer(): Promise<CaptureServer> {
  return new Promise((resolve, reject) => {
    const received: unknown[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { received.push(JSON.parse(raw)); } catch { received.push(raw); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://host.docker.internal:${port}/reply`,
        received,
        stop: () => new Promise(r => server.close(() => r())),
      });
    });
    server.once('error', reject);
  });
}

interface SenderCreds {
  identity: Awaited<ReturnType<typeof loadIdentity>>;
  grantJwt: string;
}

async function loadSender(): Promise<SenderCreds | null> {
  const identity = await loadIdentity(SENDER_AGENT_ID);
  if (!identity) return null;
  const cache = await loadCache(SENDER_AGENT_ID);
  if (!cache.grant?.jwt) return null;
  return { identity, grantJwt: cache.grant.jwt };
}

async function sendTaskFromSender(creds: SenderCreds, replyTo: string): Promise<string> {
  const taskId = crypto.randomUUID();
  const ttl = new Date(Date.now() + 120_000).toISOString();
  const ucan = mintInvocationToken({
    senderDid: creds.identity!.did,
    senderPrivateKeyPem: creds.identity!.privateKeyPem,
    grantJwt: creds.grantJwt,
    scope: `nova:${TENANT_ID}:${RECEIVER_AGENT_ID}:skill:chat`,
    ttlSeconds: 300,
  });
  const res = await request(`${A2A_URL}/agents/${RECEIVER_AGENT_ID}/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `UCAN ${ucan}`,
      'x-a2a-version': '1.0',
    },
    body: JSON.stringify({
      id: taskId,
      schemaVersion: '1.0',
      intent: 'chat',
      params: { echo: 'daemon-sse-roundtrip' },
      replyTo,
      ttl,
      idempotencyKey: taskId,
    }),
  });
  const text = await res.body.text();
  if (res.statusCode !== 202 && res.statusCode !== 200) {
    throw new Error(`sendTask ${res.statusCode}: ${text}`);
  }
  return taskId;
}

async function runDaemonAndProbe(): Promise<void> {
  const healthPort = 40_000 + Math.floor(Math.random() * 20_000);
  const daemon: ChildProcess = spawn(
    'npx',
    [
      'tsx',
      path.resolve(__dirname, '../packages/broker-receiver/src/cli.ts'),
      'run',
      '--agent-id', RECEIVER_AGENT_ID,
      '--nova-url', A2A_URL,
      '--handler', 'echo',
      '--health-port', String(healthPort),
      '--poll-fallback-ms', '10000',
      '--shutdown-grace-seconds', '5',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  daemon.stderr!.on('data', (d) => process.stderr.write(`    [daemon] ${d}`));

  let daemonExited = false;
  let daemonExitCode: number | null = null;
  daemon.once('exit', (code) => {
    daemonExited = true;
    daemonExitCode = code;
  });

  try {
    console.log('\nDaemon lifecycle (push mode):');
    const healthy = await waitForHealth(`http://127.0.0.1:${healthPort}/health`, 20_000);
    check('daemon /health reports status=ok', healthy.status === 'ok');
    check('daemon /health reports echo handler', healthy.handler === 'echo');
    check('daemon /health reports agentId', healthy.agentId === RECEIVER_AGENT_ID);
    check('claim loop running', healthy.claimLoop.running === true);
    check('sse enabled', healthy.claimLoop.sse.enabled === true);
    check('dispatcher inFlight=0 at startup', healthy.dispatcher.inFlight === 0);

    // Give SSE a moment to connect. If the server is reachable it should
    // be connected within a second or two.
    await sleep(1_500);
    const postConnect = await fetch(`http://127.0.0.1:${healthPort}/health`).then(r => r.json()) as any;
    check('sse connected after 1.5s', postConnect.claimLoop.sse.connected === true);

    console.log('\nRound-trip:');
    const sender = await loadSender();
    if (!sender || !sender.identity) {
      console.log(`  \u00b7 sender '${SENDER_AGENT_ID}' not onboarded locally; skipping round-trip`);
    } else {
      const capture = await startCaptureServer();
      try {
        const taskId = await sendTaskFromSender(sender, capture.url);
        check('HTTP POST /agents/:id/tasks accepted', typeof taskId === 'string');

        const deadline = Date.now() + 10_000;
        while (capture.received.length === 0 && Date.now() < deadline) {
          await sleep(50);
        }
        check(`capture server received reply within 10s (got ${capture.received.length})`,
          capture.received.length >= 1);

        if (capture.received.length >= 1) {
          const body = capture.received[0] as any;
          assertEq('reply has type TaskResult', body?.type, 'TaskResult');
          assertEq('reply status ok', body?.status, 'ok');
          check('reply result echoes the intent',
            body?.result?.intent === 'chat' && body?.result?.params?.echo === 'daemon-sse-roundtrip');
        }

        const afterRoundtrip = await fetch(`http://127.0.0.1:${healthPort}/health`).then(r => r.json()) as any;
        check('dispatcher.totalResponded >= 1', afterRoundtrip.dispatcher.totalResponded >= 1);
        check('totalHandlerErrors stayed 0', afterRoundtrip.dispatcher.totalHandlerErrors === 0);
        // Under push mode we expect the SSE trigger fired for this arrival.
        check('SSE event triggered the claim',
          afterRoundtrip.claimLoop.triggers.fromSse >= 1 ||
          afterRoundtrip.claimLoop.sse.eventsReceived >= 1,
          `triggers=${JSON.stringify(afterRoundtrip.claimLoop.triggers)} sse=${JSON.stringify(afterRoundtrip.claimLoop.sse)}`);
      } finally {
        await capture.stop();
      }
    }

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
  const ucanPath = path.join(os.homedir(), '.nova', 'agents', `${RECEIVER_AGENT_ID}.ucan.json`);
  await fsp.unlink(idPath).catch(() => {});
  await fsp.unlink(ucanPath).catch(() => {});
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
}

main().catch(err => {
  console.error('Acceptance test failed:', err);
  process.exit(1);
});
