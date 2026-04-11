import { Request, Response, NextFunction } from 'express';
import { TenantContext } from '@nova/shared/src/tenant';
import { logger } from '@nova/shared/src/logger';
import { redis } from '@nova/task-queue/src/index';

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
 * Falls back to legacy seed tenant for backwards compatibility.
 */
export async function tenantRouter(req: Request, res: Response, next: NextFunction) {
  const { agentId } = req.params;

  if (!agentId) {
    logger.warn('Agent routing attempted without agentId parameter');
    res.status(404).json({ error: 'Not Found' });
    return;
  }

  try {
    // Look up tenant from Redis agent index
    const tenantId = await redis.get(`nova:agent-index:${agentId}`);

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
