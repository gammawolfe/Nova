import { Router } from 'express';
import { InviteCreateSchema } from '@nova/shared/src/admin-schemas';
import { createInvite } from '@nova/shared/src/invites';
import * as tenantService from '../services/tenant-service';
import { logger } from '@nova/shared/src/logger';

export const invitesRouter = Router({ mergeParams: true });

invitesRouter.post('/', async (req, res, next) => {
  try {
    const { tenantId } = req.params as { tenantId: string };
    const tenant = await tenantService.getTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const data = InviteCreateSchema.parse(req.body ?? {});
    const { token, jti, expiresAt } = await createInvite(tenantId, data);

    logger.info({ tenantId, jti, agentIdHint: data.agentIdHint }, 'Invite issued');
    res.status(201).json({ token, jti, expiresAt, tenantId });
  } catch (err) { next(err); }
});
