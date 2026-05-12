import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { logger } from '@nova/shared/src/logger';
import { SelfRegisterSchema } from '@nova/shared/src/admin-schemas';
import { DATA_ROOT, TenantContext } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';
import { getSharedRedis } from '@nova/shared/src/redis';
import { indexAgentMeta, agentIndexKey, AGENT_LIFECYCLE_CHANNEL } from '@nova/shared/src/agent-index';
import { verifyInvite, consumeInvite } from '@nova/shared/src/invites';
import { validateId } from '@nova/shared/src/validation';
import {
  CLAIM_SECRET_HEADER, MAX_FAILED_ATTEMPTS,
  commitmentOf, commitmentEquals,
} from '@nova/shared/src/claim-secret';

export const registerRouter = Router();

const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_REGISTER || '20', 10);

// H17 — When true, reject registrations without a claimCommitment and
// require X-Claim-Secret on status fetches that would release a grant.
// Defaults off during rollout; flip to true once all MCP clients ship the
// claim-secret flow.
const REQUIRE_CLAIM_SECRET = process.env.NOVA_REQUIRE_CLAIM_SECRET === 'true';

// H4 — Redis-backed rate limiter for /register and /verify-invite. Mirrors
// the INCR + EXPIRE NX pattern used for task ingress in index.ts so the
// limit holds across multiple a2a-server instances behind a load balancer.
//
// Behaviour matrix:
//   • First request from an IP in a 60s window → INCR returns 1, EXPIRE NX
//     sets the TTL.
//   • Subsequent requests in the same window → INCR returns N; if N ≤
//     RATE_LIMIT we pass; if N > RATE_LIMIT we 429.
//   • Window expires → key is deleted by Redis; next request starts fresh.
//
// Failure mode: if Redis is unavailable, fail-open. The previous in-memory
// limiter could neither survive a restart nor coordinate across processes;
// the Redis variant is strictly stronger. If Redis goes down completely,
// blocking new agent registrations because we can't count requests would
// be a self-imposed outage on a service that's already under degraded-
// dependencies pressure. Log loudly and pass the request through — the
// rest of the pipeline still gates on invite signature verification.
async function checkRateLimit(ip: string): Promise<boolean> {
  try {
    const redis = getSharedRedis();
    const key = `nova:register-rate:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
      // First hit in this window — set the TTL so the key auto-expires.
      // EXPIRE NX is unnecessary here because we just created the key with
      // INCR; a plain EXPIRE is correct and avoids a race where two
      // concurrent INCRs both see count===1 (impossible — INCR is atomic).
      await redis.expire(key, 60);
    }
    return count <= RATE_LIMIT;
  } catch (err) {
    logger.error({ err }, 'H4: Redis unavailable during register rate-limit check; failing open');
    return true;
  }
}

/**
 * POST /register — self-registration via signed invite.
 *
 * The operator mints an invite for a tenant (admin-api), shares the token
 * out-of-band, and the agent presents it here. No tenant auto-creation —
 * tenants are created explicitly by operators in the admin UI.
 *
 * Agent starts in 'pending' status. Admin approval activates it and
 * stashes a UCAN for pickup via GET /register/status.
 */
registerRouter.post('/', async (req: Request, res: Response) => {
  const senderIp = req.ip ?? '0.0.0.0';

  if (!(await checkRateLimit(senderIp))) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many registration attempts' });
  }

  const parseResult = SelfRegisterSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'REGISTER_INVALID',
      message: 'Invalid registration request',
      details: parseResult.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const { invite, agentId, name, description, publicKey, did, operatorUrl, skills, replyUrl, claimCommitment } = parseResult.data;

  // Step 1: verify invite (signature, exp, claims) — does NOT consume.
  // The token stays live until step 5 so that any downstream validation failure
  // (mismatch, missing tenant, duplicate agent) lets the caller retry with the
  // same invite after fixing the underlying input.
  let invitePayload;
  try {
    invitePayload = await verifyInvite(invite);
  } catch (err: any) {
    return res.status(err.status ?? 400).json({
      error: 'INVITE_INVALID',
      message: err.message,
    });
  }
  const tenantId = invitePayload.tenantId;
  const agentIdHint = invitePayload.agentIdHint;

  // Step 2: agentId must match the invite's hint. agentIdHint is required on
  // newly-minted invites; rejecting hintless tokens closes a legacy path where
  // an invite could be used to register any agentId the caller chose.
  if (!agentIdHint) {
    return res.status(400).json({
      error: 'INVITE_INVALID',
      message: 'Invite has no agentIdHint — re-mint the invite with an agentIdHint set',
    });
  }
  if (agentIdHint !== agentId) {
    return res.status(400).json({
      error: 'AGENT_ID_MISMATCH',
      message: `Invite was minted for agentId '${agentIdHint}' but registration requested '${agentId}'`,
    });
  }

  // H17 — Reject hintless registrations missing claimCommitment when the
  // server flag is on. We don't enforce it unconditionally yet so that older
  // clients can still onboard during the rollout window. Operators flip the
  // flag on once their MCP fleet is upgraded.
  if (REQUIRE_CLAIM_SECRET && !claimCommitment) {
    return res.status(400).json({
      error: 'CLAIM_COMMITMENT_REQUIRED',
      message: 'This Nova requires claimCommitment in registration. Upgrade your MCP client.',
    });
  }

  const ctx: TenantContext = { tenantId, agentId };

  try {
    // Step 3: Redis cross-tenant guard runs first — agentId is global
    // within a Nova (URLs are /agents/:agentId/...), so reject pre-flight
    // if another tenant already owns it. indexAgentMeta also enforces this
    // defensively, but checking before consumeInvite avoids burning the
    // invite on a doomed registration. Cheap to run before any disk I/O
    // so the obvious-conflict path takes no disk reads.
    const claimedBy = await getSharedRedis().get(agentIndexKey(agentId));
    if (claimedBy && claimedBy !== tenantId) {
      return res.status(409).json({
        error: 'AGENT_EXISTS_OTHER_TENANT',
        message: `Agent '${agentId}' is already registered in tenant '${claimedBy}'. agentId must be unique within a Nova; pick a different one.`,
      });
    }

    // Step 4: agent must not already exist; tenant must exist.
    //
    // Optimistic check on the agent — the Redis NX in consumeInvite below
    // is the authoritative arbiter for two concurrent registrations
    // racing past this point with the same invite. A record in
    // 'deregistered' state is treated as absent — the agentId is free
    // for re-registration, which will overwrite the stale config.
    //
    // Tenant existence is checked lazily: the agent-config path includes
    // the tenant dir, so an ENOENT on agent-config either means "tenant
    // exists, agent doesn't" (proceed) or "tenant doesn't exist either"
    // (404). Only the rare ENOENT path takes the extra tenant.json
    // access; the common-case fresh registration and the agent-exists
    // path each take a single disk read.
    const configPath = path.join(DATA_ROOT, 'tenants', tenantId, 'agents', agentId, 'agent-config.json');
    let priorDeregistered = false;
    let priorRaw: string | null = null;
    try {
      priorRaw = await fsp.readFile(configPath, 'utf8');
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      // agent-config missing — could be "agent fresh" OR "tenant gone".
      // Distinguish via tenant.json existence; only this rare path
      // pays the second disk hit.
      const tenantConfigPath = path.join(DATA_ROOT, 'tenants', tenantId, 'tenant.json');
      try {
        await fsp.access(tenantConfigPath);
      } catch {
        return res.status(404).json({
          error: 'TENANT_NOT_FOUND',
          message: `Tenant ${tenantId} no longer exists`,
        });
      }
    }
    if (priorRaw) {
      const prior = JSON.parse(priorRaw);
      if (prior.status === 'deregistered') {
        priorDeregistered = true;
      } else {
        return res.status(409).json({
          error: 'AGENT_EXISTS',
          message: `Agent '${agentId}' is already registered in tenant '${tenantId}'`,
          statusUrl: `/register/status/${tenantId}/${agentId}`,
        });
      }
    }

    // Step 5: consume the invite atomically. All reversible validation is done;
    // any failure after this point leaves the invite burned, which is acceptable
    // because it means we're past the point of agent-caused input errors.
    try {
      await consumeInvite(invitePayload);
    } catch (err: any) {
      return res.status(err.status ?? 409).json({
        error: 'INVITE_INVALID',
        message: err.message,
      });
    }

    const agentDir = path.join(DATA_ROOT, 'tenants', tenantId, 'agents', agentId);
    if (priorDeregistered) {
      // Wipe the prior agent's on-disk state so a new identity doesn't inherit
      // stale trust entries, dead-letter items, or confirm-queue tasks from the
      // previous lifetime under this agentId.
      await fsp.rm(agentDir, { recursive: true, force: true });
    }
    await Promise.all(
      ['trust-registry', 'quarantine', 'dead-letter', 'confirm-queue'].map(sub =>
        fsp.mkdir(path.join(agentDir, sub), { recursive: true })
      )
    );

    const config = {
      agentId,
      tenantId,
      name,
      description,
      version: '1.0.0',
      operatorUrl,
      skills,
      highPrivilegeSkills: [],
      confirmTimeouts: {},
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
      authentication: { schemes: ['ucan'], ucapabilityPrefix: `nova:${tenantId}:${agentId}` },
      createdAt: new Date().toISOString(),
      status: 'pending' as const,
      did,
      publicKey,
      replyUrl,
      claimCommitment,
    };

    await writeAtomicallyAsync(configPath, config);

    const redis = getSharedRedis();
    await indexAgentMeta(redis, config);
    await redis.publish(AGENT_LIFECYCLE_CHANNEL, JSON.stringify({
      action: 'created', tenantId, agentId, status: 'pending',
    }));

    res.status(201).json({
      status: 'pending',
      tenantId,
      agentId,
      statusUrl: `/register/status/${tenantId}/${agentId}`,
      pendingReason: 'Awaiting operator approval',
    });
  } catch (err: any) {
    logger.error({ err, tenantId, agentId }, 'Failed to register agent');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Registration failed' });
  }
});

/**
 * POST /register/verify-invite — signature + tenant-existence check, no consumption.
 *
 * Lets MCP clients validate an invite before writing it to local state, which
 * prevents stale or mistyped tokens from corrupting the joined-tenant config.
 * Returns the decoded payload on success; 4xx with the usual error codes
 * (INVITE_INVALID, TENANT_NOT_FOUND) otherwise. Rate-limited the same as POST /.
 */
registerRouter.post('/verify-invite', async (req: Request, res: Response) => {
  const senderIp = req.ip ?? '0.0.0.0';
  if (!(await checkRateLimit(senderIp))) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'RATE_LIMITED' });
  }

  const token = typeof req.body?.invite === 'string' ? req.body.invite : null;
  if (!token) return res.status(400).json({ error: 'INVITE_INVALID', message: 'invite field required' });

  let payload;
  try {
    payload = await verifyInvite(token);
  } catch (err: any) {
    return res.status(err.status ?? 400).json({ error: 'INVITE_INVALID', message: err.message });
  }

  const tenantConfigPath = path.join(DATA_ROOT, 'tenants', payload.tenantId, 'tenant.json');
  try {
    await fsp.access(tenantConfigPath);
  } catch {
    return res.status(404).json({
      error: 'TENANT_NOT_FOUND',
      message: `Tenant ${payload.tenantId} does not exist on this Nova`,
    });
  }

  res.json({
    tenantId: payload.tenantId,
    agentIdHint: payload.agentIdHint,
    exp: payload.exp,
    jti: payload.jti,
  });
});

/**
 * GET /register/status/:tenantId/:agentId — polling endpoint for pending registrations.
 *
 * Returns the current agent status and, on first fetch after approval, the
 * approval-grant JWT (stashed in Redis by the admin-api approve route with a
 * 24h TTL). The claim is deleted on read so a compromised endpoint can't
 * re-read credentials.
 *
 * H17 — Grant pickup is gated by the claim-secret commitment registered in
 * POST /register. Callers present the secret in X-Claim-Secret; the server
 * compares its SHA-256 against the stored commitment in constant time.
 *
 * Behaviour matrix:
 *
 *   | Agent has commitment? | Header present?  | Grant returned? |
 *   |-----------------------|------------------|-----------------|
 *   | yes                   | yes & match      | YES (one-shot)  |
 *   | yes                   | yes & mismatch   | NO (count++)    |
 *   | yes                   | missing          | NO              |
 *   | no  (legacy)          | (any)            | YES if flag off |
 *   | no  (legacy)          | (any)            | NO if flag on   |
 *
 * After MAX_FAILED_ATTEMPTS mismatches the claim is deleted; the operator
 * must run nova_reissue_ucan to re-enable pickup.
 *
 * Status fields (status, tenantId, agentId) are always returned regardless
 * of secret presentation — only the grant payload is gated. This lets the
 * agent discover its own approval state without burning the secret.
 *
 * Response shapes:
 *   { status: 'pending' }
 *   { status: 'active', grant: { jwt, cid, expiresAt, trustTier } }   // first authorised fetch
 *   { status: 'active' }                                               // subsequent or unauthorised
 *   { status: 'deregistered' }
 *   { status: 'active', error: 'CLAIM_LOCKED' }                       // too many mismatches
 *   404 if agent does not exist
 */
registerRouter.get('/status/:tenantId/:agentId', async (req: Request, res: Response) => {
  const tenantId = req.params['tenantId'];
  const agentId = req.params['agentId'];
  if (!tenantId || !agentId) {
    return res.status(400).json({ error: 'INVALID_IDS' });
  }
  try {
    validateId(tenantId, 'tenantId');
    validateId(agentId, 'agentId');
  } catch {
    return res.status(400).json({ error: 'INVALID_IDS' });
  }

  const configPath = path.join(DATA_ROOT, 'tenants', tenantId, 'agents', agentId, 'agent-config.json');
  let agent: any;
  try {
    agent = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch {
    return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
  }

  const response: any = { status: agent.status, tenantId, agentId };

  if (agent.status !== 'active') {
    return res.json(response);
  }

  const redis = getSharedRedis();
  const claimKey = `nova:grant-claim:${tenantId}:${agentId}`;
  const failKey = `nova:grant-claim-fails:${tenantId}:${agentId}`;

  // H3 — Use a non-destructive read for the existence check and verification
  // gates. The claim is only consumed atomically (via GETDEL) at the moment
  // we've decided to deliver it, which guarantees that two concurrent
  // pollers can never both succeed: one wins the GETDEL and gets the
  // payload, the other sees null and falls through to the no-grant branch.
  //
  // Verification-failure paths (wrong secret, missing secret, lockout) do
  // NOT consume the claim — only successful delivery does, and the lockout
  // path explicitly burns the claim with `del`.
  const claim = await redis.get(claimKey);
  if (!claim) {
    // Already claimed (or never approved) — return status without grant.
    return res.json(response);
  }

  // H17 verification path
  const presented = req.header(CLAIM_SECRET_HEADER);
  const storedCommitment = agent.claimCommitment as string | undefined;

  // Legacy registrations have no commitment. When the flag is off we return
  // the grant for backwards compat; when on, we refuse and the agent must
  // re-register (or have its grant reissued via the operator path).
  if (!storedCommitment) {
    if (REQUIRE_CLAIM_SECRET) {
      return res.json(response);
    }
    // Legacy: deliver grant once, just like before H17.
    return deliverAtomic(res, response, redis, claimKey);
  }

  if (typeof presented !== 'string' || presented.length === 0) {
    // Commitment present but no header — caller must prove possession.
    // Don't increment the failure counter for the missing case; that lets
    // an out-of-date client poll until it learns it needs the secret.
    return res.json(response);
  }

  const presentedCommitment = commitmentOf(presented);
  if (!commitmentEquals(presentedCommitment, storedCommitment)) {
    // Mismatch — increment fail counter, lock after threshold.
    const fails = await redis.incr(failKey);
    if (fails === 1) {
      // Match the claim TTL so the counter expires alongside the grant.
      await redis.expire(failKey, 24 * 3600);
    }
    if (fails >= MAX_FAILED_ATTEMPTS) {
      // Burn the claim. Operator must reissue; legitimate agent rotates.
      await redis.del(claimKey);
      logger.warn(
        { tenantId, agentId, fails },
        'H17: claim locked after repeated secret mismatch',
      );
      return res.json({ ...response, error: 'CLAIM_LOCKED' });
    }
    logger.warn(
      { tenantId, agentId, fails },
      'H17: claim secret mismatch',
    );
    return res.json(response);
  }

  // Verified — deliver the grant atomically and clear the fail counter.
  await redis.del(failKey);
  return deliverAtomic(res, response, redis, claimKey);
});

/**
 * Atomic claim delivery: GETDEL pops the claim from Redis in a single
 * round-trip. Returns the parsed grant in the response if the claim was
 * still present, otherwise returns the response without a grant — the
 * latter happens when a concurrent poller already won the race for this
 * claim. Idempotent and safe to call once per request.
 *
 * Requires Redis 6.2+ (GETDEL command). Earlier Redis versions need the
 * pre-H3 get-then-del pattern, which is racy by construction.
 */
async function deliverAtomic(
  res: Response,
  response: any,
  redis: ReturnType<typeof getSharedRedis>,
  claimKey: string,
): Promise<Response> {
  const claim = await redis.getdel(claimKey);
  if (!claim) {
    // Lost the race — another poller already consumed the claim.
    return res.json(response);
  }
  try {
    response.grant = JSON.parse(claim);
  } catch {
    logger.warn({ claimKey }, 'Malformed grant claim payload');
  }
  return res.json(response);
}
