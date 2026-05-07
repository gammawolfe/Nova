import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { logger } from '@nova/shared/src/logger';
import { SelfRegisterSchema } from '@nova/shared/src/admin-schemas';
import { DATA_ROOT, TenantContext } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';
import { getSharedRedis } from '@nova/shared/src/redis';
import { indexAgentMeta, AGENT_LIFECYCLE_CHANNEL } from '@nova/shared/src/agent-index';
import { verifyInvite, consumeInvite } from '@nova/shared/src/invites';
import { validateId } from '@nova/shared/src/validation';
import {
  CLAIM_SECRET_HEADER, MAX_FAILED_ATTEMPTS,
  commitmentOf, commitmentEquals,
} from '@nova/shared/src/claim-secret';

export const registerRouter = Router();

const rateStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_REGISTER || '20', 10);

// H17 — When true, reject registrations without a claimCommitment and
// require X-Claim-Secret on status fetches that would release a grant.
// Defaults off during rollout; flip to true once all MCP clients ship the
// claim-secret flow.
const REQUIRE_CLAIM_SECRET = process.env.NOVA_REQUIRE_CLAIM_SECRET === 'true';

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateStore.get(ip);
  if (!entry || now > entry.resetAt) {
    rateStore.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateStore) {
    if (now > entry.resetAt) rateStore.delete(ip);
  }
}, 60_000);

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

  if (!checkRateLimit(senderIp)) {
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

  // Step 3: tenant must still exist.
  const tenantConfigPath = path.join(DATA_ROOT, 'tenants', tenantId, 'tenant.json');
  try {
    await fsp.access(tenantConfigPath);
  } catch {
    return res.status(404).json({
      error: 'TENANT_NOT_FOUND',
      message: `Tenant ${tenantId} no longer exists`,
    });
  }

  const ctx: TenantContext = { tenantId, agentId };

  try {
    // Step 4: agent must not already exist. Optimistic check; the Redis NX in
    // consumeInvite below is the authoritative arbiter for two concurrent
    // registrations that race past this point with the same invite.
    // A record in 'deregistered' state is treated as absent — the agentId is
    // free for re-registration, which will overwrite the stale config.
    const configPath = path.join(DATA_ROOT, 'tenants', tenantId, 'agents', agentId, 'agent-config.json');
    let priorDeregistered = false;
    try {
      const raw = await fsp.readFile(configPath, 'utf8');
      const prior = JSON.parse(raw);
      if (prior.status === 'deregistered') {
        priorDeregistered = true;
      } else {
        return res.status(409).json({
          error: 'AGENT_EXISTS',
          message: `Agent '${agentId}' is already registered in tenant '${tenantId}'`,
          statusUrl: `/register/status/${tenantId}/${agentId}`,
        });
      }
    } catch { /* agent doesn't exist — proceed */ }

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
  if (!checkRateLimit(senderIp)) {
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
    return deliverAndDelete(res, response, claim, redis, claimKey);
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

  // Verified — deliver the grant and burn the claim.
  await redis.del(failKey);
  return deliverAndDelete(res, response, claim, redis, claimKey);
});

/**
 * Common one-shot delivery: parse the claim payload, attach to response,
 * and delete the Redis entry. Encapsulated so the legacy and the verified
 * paths converge on identical behaviour.
 */
async function deliverAndDelete(
  res: Response,
  response: any,
  claim: string,
  redis: ReturnType<typeof getSharedRedis>,
  claimKey: string,
): Promise<Response> {
  try {
    response.grant = JSON.parse(claim);
    await redis.del(claimKey);
  } catch {
    logger.warn({ claimKey }, 'Malformed grant claim payload');
  }
  return res.json(response);
}
