// packages/broker-receiver/src/init.ts
//
// One-shot onboarding for a fresh receiver identity. Runs the same
// registration dance the mcp-server prompts do, but from a non-
// interactive CLI so an operator can spin up a daemon with a single
// command.
//
// Steps:
//   1. Generate an Ed25519 identity and persist it to ~/.nova/agents/<id>.json
//      via the active KeyBackend (reuses mcp-server's identity module).
//   2. Decode the invite locally to pull tenantId + agentIdHint so we can
//      fail fast on mismatches instead of hitting the server.
//   3. POST /register with a minimal skill card. The receiver registers
//      with a single 'chat' skill — the handler decides what to do with
//      the intent. Operators can edit the skill list via admin-api.
//   4. Poll /register/status until approved; on approval the grant JWT
//      is stashed locally by check_registration equivalent.
//   5. Write ~/.nova/broker-receiver.json with resolved config defaults
//      so subsequent `run` needs no flags.

import fsp from 'fs/promises';
import { request } from 'undici';
import { generateIdentity, saveIdentity, loadIdentity } from '@nova/mcp-server/src/identity';
import { decodeInvitePayload, saveTenantConfig } from '@nova/mcp-server/src/tenant-config';
import { loadCache, saveCache, withCacheLock } from '@nova/mcp-server/src/ucan-store';
import { DEFAULT_CONFIG_PATH } from './config.js';

export interface InitOptions {
  agentId: string;
  invite: string;
  novaUrl: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  stderrLine({ step: 'init_start', agentId: opts.agentId, novaUrl: opts.novaUrl });

  // 1. Decode the invite locally so we can sanity-check before generating keys.
  const payload = decodeInvitePayload(opts.invite);
  if (payload.agentIdHint && payload.agentIdHint !== opts.agentId) {
    throw new Error(
      `agentId mismatch: --agent-id=${opts.agentId} but invite agentIdHint=${payload.agentIdHint}`,
    );
  }
  stderrLine({ step: 'invite_decoded', tenantId: payload.tenantId, jti: payload.jti, expiresAt: new Date(payload.exp * 1000).toISOString() });

  // 2. Do not clobber an existing identity. If one exists for this agentId,
  // reuse it — the operator may be re-running init after a crash.
  const existing = await loadIdentity(opts.agentId);
  let identity = existing;
  if (!identity) {
    identity = generateIdentity(opts.agentId);
    await saveIdentity(identity);
    stderrLine({ step: 'identity_generated', did: identity.did });
  } else {
    stderrLine({ step: 'identity_reused', did: identity.did });
  }

  // 3. Register. The receiver declares a single 'chat' skill by default —
  // operators who need more granular intent routing can update the
  // agent card via admin-api after approval.
  await saveTenantConfig({
    novaUrl: opts.novaUrl,
    tenantId: payload.tenantId,
    ...(payload.agentIdHint ? { agentIdHint: payload.agentIdHint } : {}),
    inviteJti: payload.jti,
    joinedAt: new Date().toISOString(),
  });

  const registerBody = {
    invite: opts.invite,
    agentId: opts.agentId,
    name: `Broker Receiver ${opts.agentId}`,
    description: 'Supervised broker-mode receiver. Pulls tasks from Nova and dispatches to a configured handler.',
    publicKey: identity.publicKey,
    did: identity.did,
    skills: [
      {
        id: 'chat',
        name: 'Chat',
        description: 'Accept a text prompt and return a text response.',
        tags: ['chat', 'general'],
      },
    ],
  };

  const regRes = await request(join(opts.novaUrl, '/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registerBody),
  });
  const regText = await regRes.body.text();
  const regParsed = safeJson(regText);
  if (regRes.statusCode === 409) {
    stderrLine({ step: 'already_registered', note: 'proceeding to approval poll' });
  } else if (regRes.statusCode !== 201) {
    throw new Error(`register failed ${regRes.statusCode}: ${regText}`);
  } else {
    stderrLine({ step: 'registered', status: (regParsed as any)?.status });
  }

  // 4. Poll for approval with escalating backoff, matching the prompt's
  //    documented behaviour: ask operator to approve via admin UI.
  stderrLine({ step: 'awaiting_approval', hint: `curl -X POST http://127.0.0.1:3005/admin/tenants/${payload.tenantId}/agents/${opts.agentId}/approve -H "Authorization: Bearer $NOVA_ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"trustTier":2}'` });

  const delays = [2_000, 2_000, 5_000, 5_000, 10_000, 10_000, 30_000, 30_000, 60_000];
  for (let i = 0; i < 60; i++) {
    const res = await request(join(opts.novaUrl, `/register/status/${payload.tenantId}/${opts.agentId}`), {
      method: 'GET',
    });
    const text = await res.body.text();
    const status = safeJson(text) as any;
    if (status?.status === 'active' && status?.grant) {
      await withCacheLock(opts.agentId, async () => {
        const cache = await loadCache(opts.agentId);
        cache.grant = {
          jwt: status.grant.jwt,
          cid: status.grant.cid,
          expiresAt: status.grant.expiresAt,
        };
        await saveCache(cache);
      });
      stderrLine({ step: 'grant_claimed', expiresAt: status.grant.expiresAt, trustTier: status.grant.trustTier });
      break;
    }
    if (status?.status === 'active' && !status?.grant) {
      throw new Error(
        'Agent active but grant claim expired. Run nova_reissue_ucan against the admin API, then re-run init.',
      );
    }
    const delay = delays[Math.min(i, delays.length - 1)] ?? 60_000;
    await sleep(delay);
  }

  // 5. Write broker-receiver config with defaults so `run` needs no flags.
  const defaultConfig = {
    agentId: opts.agentId,
    novaUrl: opts.novaUrl,
    handler: 'echo',
    handlerConfig: {},
    pollWaitMs: 30_000,
    maxConcurrentTasks: 1,
    healthPort: 0,
    shutdownGraceSeconds: 30,
    logLevel: 'info',
  };
  // Only write the config file if it doesn't exist — don't clobber
  // operator customization.
  try {
    await fsp.access(DEFAULT_CONFIG_PATH);
    stderrLine({ step: 'config_exists', path: DEFAULT_CONFIG_PATH, note: 'not overwritten' });
  } catch {
    await fsp.mkdir(DEFAULT_CONFIG_PATH.replace(/\/[^/]+$/, ''), { recursive: true, mode: 0o700 });
    await fsp.writeFile(DEFAULT_CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), { mode: 0o600 });
    stderrLine({ step: 'config_written', path: DEFAULT_CONFIG_PATH });
  }

  stderrLine({ step: 'init_done', nextStep: 'broker-receiver run' });
}

function join(base: string, p: string): string {
  return base.replace(/\/$/, '') + (p.startsWith('/') ? p : `/${p}`);
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function stderrLine(obj: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info', ...obj }) + '\n');
}
