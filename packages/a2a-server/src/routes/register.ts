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
    const configPath = path.join(DATA_ROOT, 'tenants', tenantId, 'agents', agentId, 'agent-config.json');
    try {
      await fsp.access(configPath);
      return res.status(409).json({
        error: 'AGENT_EXISTS',
        message: `Agent '${agentId}' is already registered in tenant '${tenantId}'`,
        statusUrl: `/register/status/${tenantId}/${agentId}`,
      });
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
 * GET /register/status/:tenantId/:agentId — polling endpoint for pending registrations.
 *
 * Returns the current agent status and, on first fetch after approval, the UCAN JWT
 * (stashed in Redis by the admin-api approve route with 1h TTL). The claim is deleted
 * on read so a compromised endpoint can't re-read credentials.
 *
 * Response shapes:
 *   { status: 'pending' }
 *   { status: 'active', ucan: { jwt, expiresAt, trustTier, ucanRenewalUrl } }   // only on first fetch
 *   { status: 'active' }                                                          // subsequent fetches
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
    const claimKey = `nova:ucan-claim:${tenantId}:${agentId}`;
    const claim = await redis.get(claimKey);
    if (claim) {
      try {
        response.ucan = JSON.parse(claim);
        await redis.del(claimKey);
      } catch {
        logger.warn({ tenantId, agentId }, 'Malformed UCAN claim payload');
      }
    }
  }

  res.json(response);
});
