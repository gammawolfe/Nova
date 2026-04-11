import { Request, Response, NextFunction } from 'express';
import { TenantContext } from '@nova/shared/src/tenant';
import { logger } from '@nova/shared/src/logger';

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
 * 
 * In a fully built model, this will query Redis or the DB to resolve:
 * 1. Does the agentId exist?
 * 2. Which tenantId owns it?
 * 
 * For Milestone 1 building, we mock the tenant resolution to ensure plumbing works.
 */
export async function tenantRouter(req: Request, res: Response, next: NextFunction) {
  const { agentId } = req.params;

  if (!agentId) {
    logger.warn('Agent routing attempted without agentId parameter');
    res.status(404).json({ error: 'Not Found' });
    return;
  }

  try {
    // TODO (Milestone 2): Replace with actual DB/Redis tenant mapping lookup.
    // Stubbing a single explicit test tenant isolation for now
    req.ctx = {
      tenantId: 'tenant_seed_123',
      agentId: agentId
    };

    next();
  } catch (error) {
    logger.error({ err: error, agentId }, 'Failed to resolve tenant context');
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
