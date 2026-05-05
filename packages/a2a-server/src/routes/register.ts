import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { logger } from '@nova/shared';
import { SelfRegisterSchema } from '@nova/shared';
import { DATA_ROOT, TenantContext } from '@nova/shared';
import { writeAtomicallyAsync } from '@nova/shared';
import { getSharedRedis } from '@nova/shared';
import { indexAgentMeta, AGENT_LIFECYCLE_CHANNEL } from '@nova/shared';
import { verifyInvite, consumeInvite } from '@nova/shared';
import { validateId } from '@nova/shared';

export const registerRouter = Router();

const rateStore = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_REGISTER || '20', 10);

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

  const { invite, agentId, name, description, publicKey, did, operatorUrl, skills, replyUrl } = parseResult.data;

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
 * Response shapes:
 *   { status: 'pending' }
 *   { status: 'active', grant: { jwt, cid, expiresAt, trustTier } }   // only on first fetch
 *   { status: 'active' }                                               // subsequent fetches
 *   { status: 'deregistered' }
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

  if (agent.status === 'active') {
    const redis = getSharedRedis();
    const claimKey = `nova:grant-claim:${tenantId}:${agentId}`;
    const claim = await redis.get(claimKey);
    if (claim) {
      try {
        response.grant = JSON.parse(claim);
        await redis.del(claimKey);
      } catch {
        logger.warn({ tenantId, agentId }, 'Malformed grant claim payload');
      }
    }
  }

  res.json(response);
});
