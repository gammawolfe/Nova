import { Request } from 'express';
import { TenantContext } from '@nova/shared/src/tenant';

/** Extract TenantContext from route params — shared across admin-api routes. */
export function ctx(req: Request): TenantContext {
  return { tenantId: (req.params as any).tenantId, agentId: (req.params as any).agentId };
}
