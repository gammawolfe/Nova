import { Request, Response, NextFunction } from 'express';
import IORedis from 'ioredis';
import { TenantContext } from '@nova/shared/src/tenant';
import { logger } from '@nova/shared/src/logger';
import { getSharedRedis } from '@nova/shared/src/redis';
import {
  agentIndexKey,
  AGENT_LIFECYCLE_CHANNEL,
  AgentLifecycleEvent,
} from '@nova/shared/src/agent-index';

// Extend Express Request tightly so the compiler knows ctx is always present downstream
declare global {
  namespace Express {
    interface Request {
      ctx: TenantContext;
    }
  }
}

// ── Cached agentId → tenantId resolution ───────────────────────────────────
//
// Tenant resolution runs on every authenticated request to /agents/:agentId/*.
// The mapping is durable — agentIds are global within a Nova (see
// AgentIdConflictError) and change only on register/deregister, both of
// which publish to AGENT_LIFECYCLE_CHANNEL.
//
// The cache:
//   - holds (agentId → tenantId) entries
//   - is bounded to TENANT_CACHE_MAX entries by ordered-Map eviction
//   - is invalidated promptly by a pub/sub subscription to the lifecycle
//     channel: any 'created', 'approved', or 'deregistered' event for an
//     agentId evicts that entry
//   - also enforces a TTL safety net so a dropped subscription or a
//     publish loss doesn't pin a stale value forever
//
// On unsubscribe / Redis disconnect we clear the cache wholesale to
// fail-safe back to per-request Redis lookups.

interface CacheEntry {
  tenantId: string;
  expiresAt: number;
}

const TENANT_CACHE_TTL_MS = 5 * 60 * 1000;
const TENANT_CACHE_MAX = 4_096;

const tenantCache = new Map<string, CacheEntry>();
let lifecycleSub: IORedis | null = null;
let lifecycleSubStarted = false;

function cacheGet(agentId: string): string | null {
  const entry = tenantCache.get(agentId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    tenantCache.delete(agentId);
    return null;
  }
  // LRU touch: re-insert to move to the end of the iteration order.
  tenantCache.delete(agentId);
  tenantCache.set(agentId, entry);
  return entry.tenantId;
}

function cacheSet(agentId: string, tenantId: string): void {
  if (tenantCache.size >= TENANT_CACHE_MAX) {
    // Drop oldest insertion-order entry. Map preserves insertion order
    // and we touch entries on read, so this is a least-recently-used eviction.
    const oldestKey = tenantCache.keys().next().value;
    if (oldestKey !== undefined) tenantCache.delete(oldestKey);
  }
  tenantCache.set(agentId, { tenantId, expiresAt: Date.now() + TENANT_CACHE_TTL_MS });
}

function cacheEvict(agentId: string): void {
  tenantCache.delete(agentId);
}

/**
 * Subscribe to AGENT_LIFECYCLE_CHANNEL on first request so that
 * register/approve/deregister events evict the affected cache entry
 * promptly. Lazy so a never-used process pays nothing, and a unit
 * test that doesn't exercise the route doesn't spin up a subscriber.
 * Idempotent: the started flag plus null-checking means concurrent
 * first-request callers race harmlessly.
 */
function startLifecycleSubscriber(): void {
  if (lifecycleSubStarted) return;
  lifecycleSubStarted = true;
  try {
    lifecycleSub = getSharedRedis().duplicate();
    lifecycleSub.subscribe(AGENT_LIFECYCLE_CHANNEL).catch(err => {
      logger.warn({ err: err?.message }, 'tenant-router: lifecycle subscribe failed; cache will rely on TTL only');
    });
    lifecycleSub.on('message', (_channel, message) => {
      try {
        const event = JSON.parse(message) as AgentLifecycleEvent;
        if (event?.agentId) cacheEvict(event.agentId);
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'tenant-router: malformed lifecycle message');
      }
    });
    lifecycleSub.on('error', (err) => {
      logger.warn({ err: err.message }, 'tenant-router: lifecycle subscriber error; flushing cache');
      tenantCache.clear();
    });
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'tenant-router: failed to start lifecycle subscriber');
  }
}

/**
 * Stop the lifecycle subscriber and flush the cache. Called from
 * lifecycle.ts during graceful shutdown so the duplicated Redis
 * connection is released cleanly.
 */
export async function stopTenantRouterCache(): Promise<void> {
  if (lifecycleSub) {
    try { await lifecycleSub.unsubscribe(); } catch { /* tolerated */ }
    try { await lifecycleSub.quit(); } catch { /* tolerated */ }
    lifecycleSub = null;
  }
  lifecycleSubStarted = false;
  tenantCache.clear();
}

/**
 * Middleware resolving the agent URL parameter into a TenantContext.
 * Looks up the in-process cache first; on miss queries the Redis agent
 * index (populated by admin-api on agent creation). Returns 404 when
 * the agent isn't registered on this Nova.
 */
export async function tenantRouter(req: Request, res: Response, next: NextFunction) {
  const { agentId } = req.params;

  if (!agentId) {
    logger.warn('Agent routing attempted without agentId parameter');
    res.status(404).json({ error: 'Not Found' });
    return;
  }

  // Lazy-start the lifecycle subscriber. Subsequent calls are no-ops.
  startLifecycleSubscriber();

  const cached = cacheGet(agentId);
  if (cached) {
    req.ctx = { tenantId: cached, agentId };
    next();
    return;
  }

  try {
    const tenantId = await getSharedRedis().get(agentIndexKey(agentId));

    if (!tenantId) {
      logger.warn({ agentId }, 'Agent not found in Redis index');
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    cacheSet(agentId, tenantId);
    req.ctx = { tenantId, agentId };
    next();
  } catch (error) {
    logger.error({ err: error, agentId }, 'Failed to resolve tenant context');
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
