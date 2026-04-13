import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import IORedis from 'ioredis';
import fsp from 'fs/promises';
import path from 'path';
import { logger } from '@nova/shared/src/logger';
import { SelfRegisterSchema } from '@nova/shared/src/admin-schemas';
import { DATA_ROOT, TenantContext } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
let redis: IORedis | null = null;
function getRedis(): IORedis {
  if (!redis) redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  return redis;
}

const ID_RE = /^[a-z0-9_-]{1,64}$/;

export const registerRouter = Router();

// Simple in-memory rate limiter: IP → count, reset every 60s
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
  if (entry.count > RATE_LIMIT) return false;
  return true;
}

/**
 * Look up a tenant by slug, or create one automatically.
 */
async function getOrCreateTenant(slug: string, name: string): Promise<string> {
  const tenantsDir = path.join(DATA_ROOT, 'tenants');
  let dirs: string[];
  try {
    dirs = await fsp.readdir(tenantsDir);
  } catch {
    dirs = [];
  }

  for (const d of dirs) {
    if (!ID_RE.test(d)) continue;
    try {
      const raw = await fsp.readFile(path.join(tenantsDir, d, 'tenant.json'), 'utf8');
      const tenant = JSON.parse(raw);
      if (tenant.slug === slug) return d;
    } catch { /* skip */ }
  }

  // Auto-create tenant
  const tenantId = `tenant_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const tenantDir = path.join(tenantsDir, tenantId);
  await fsp.mkdir(tenantDir, { recursive: true });

  const tenantData = {
    id: tenantId,
    name,
    slug,
    createdAt: new Date().toISOString(),
    status: 'active' as const,
    plan: 'developer' as const,
    quotas: {
      messagesPerDay: 1000,
      agentsMax: 5,
      trustedSendersMax: 50,
    },
  };
  await writeAtomicallyAsync(path.join(tenantDir, 'tenant.json'), tenantData);

  logger.info({ tenantId, slug, name }, 'Tenant auto-created during self-registration');
  return tenantId;
}

/**
 * POST /register — self-registration endpoint
 *
 * Creates an agent in 'pending' status. Requires admin approval before activation.
 * Agent is indexed in Redis (so discoverable) but gate pipeline will quarantine
 * tasks because DID is not in trust registry yet.
 */
registerRouter.post('/', async (req: Request, res: Response) => {
  const senderIp = req.ip ?? '0.0.0.0';
  const requestId = crypto.randomUUID();

  // Rate limiting
  if (!checkRateLimit(senderIp)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many registration attempts' });
  }

  // Validate request body
  const parseResult = SelfRegisterSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'REGISTER_INVALID',
      message: 'Invalid registration request',
      details: parseResult.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const { agentId, tenantSlug, tenantName, name, description, publicKey, did, operatorUrl, skills, replyUrl } = parseResult.data;
  const ctx: TenantContext = { tenantId: '', agentId };

  try {
    // Get or create tenant
    const tenantId = await getOrCreateTenant(tenantSlug, tenantName);
    ctx.tenantId = tenantId;

    // Check if agent already exists
    const configPath = path.join(DATA_ROOT, 'tenants', tenantId, 'agents', agentId, 'agent-config.json');
    try {
      await fsp.access(configPath);
      return res.status(409).json({
        error: 'AGENT_EXISTS',
        message: `Agent '${agentId}' is already registered`,
        statusUrl: `/agents/${agentId}`,
      });
    } catch {
      // Agent doesn't exist — safe to create
    }

    // Create agent directories
    const agentDir = path.join(DATA_ROOT, 'tenants', tenantId, 'agents', agentId);
    await Promise.all(
      ['trust-registry', 'quarantine', 'dead-letter', 'confirm-queue'].map(sub =>
        fsp.mkdir(path.join(agentDir, sub), { recursive: true })
      )
    );

    // Create agent config in 'pending' status
    const config = {
      agentId,
      tenantId,
      name,
      description,
      version: '1.0.0',
      operatorUrl: operatorUrl,
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

    // Index in Redis (makes agent discoverable but NOT communicable — gate blocks pending agents)
    await getRedis().set(`nova:agent-index:${agentId}`, tenantId);

    const registrationId = `reg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    res.status(201).json({
      status: 'pending',
      registrationId,
      tenantId,
      agentId,
      pendingReason: 'Requires admin approval before activation',
      agentUrl: `/agents/${agentId}`,
    });

  } catch (err: any) {
    logger.error({ err, agentId }, 'Failed to register agent');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Registration failed' });
  }
});
