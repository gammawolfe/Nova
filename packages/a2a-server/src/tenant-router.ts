import { Request, Response, NextFunction } from 'express';
import { TenantContext } from '@nova/shared/src/tenant';
import { logger } from '@nova/shared/src/logger';
import { getSharedRedis } from '@nova/shared/src/redis';
import { agentIndexKey } from '@nova/shared/src/agent-index';

// Extend Express Request tightly so the compiler knows ctx is always present downstream
declare global {
  namespace Express {
    interface Request {
      ctx: TenantContext;
    }
  }
}

/**
 * Middleware resolving the agent URL parameter into a TenantContext.
 * Queries the Redis agent index (populated by admin-api on agent creation).
 * Returns 404 when the agent isn't registered on this Nova.
 */
export async function tenantRouter(req: Request, res: Response, next: NextFunction) {
  const { agentId } = req.params;

  if (!agentId) {
    logger.warn('Agent routing attempted without agentId parameter');
    res.status(404).json({ error: 'Not Found' });
    return;
  }

  try {
    // Look up tenant from Redis agent index. Uses the canonical key
    // builder rather than a raw template string so the key format
    // can't drift from the writer side (agent-index.ts).
    const tenantId = await getSharedRedis().get(agentIndexKey(agentId));

    if (!tenantId) {
      logger.warn({ agentId }, 'Agent not found in Redis index');
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    req.ctx = { tenantId, agentId };
    next();
  } catch (error) {
    logger.error({ err: error, agentId }, 'Failed to resolve tenant context');
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
