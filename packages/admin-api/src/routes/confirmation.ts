import { Router } from 'express';
import { TenantContext } from '@nova/shared/src/tenant';
import { ConfirmApproveSchema } from '@nova/shared/src/admin-schemas';
import * as confirmService from '../services/confirmation-service';

export const confirmationRouter = Router({ mergeParams: true });

function ctx(req: any): TenantContext {
  return { tenantId: req.params.tenantId, agentId: req.params.agentId };
}

confirmationRouter.get('/', async (req, res, next) => {
  try {
    res.json(await confirmService.listPending(ctx(req)));
  } catch (err) { next(err); }
});

confirmationRouter.get('/:id', async (req, res, next) => {
  try {
    const entry = await confirmService.getConfirmRequest(ctx(req), req.params.id);
    if (!entry) return res.status(404).json({ error: 'Confirmation request not found' });
    res.json(entry);
  } catch (err) { next(err); }
});

confirmationRouter.post('/:id', async (req, res, next) => {
  try {
    const { reviewedBy } = ConfirmApproveSchema.parse(req.body);
    const entry = await confirmService.approveConfirmRequest(ctx(req), req.params.id, reviewedBy);
    if (!entry) return res.status(404).json({ error: 'Confirmation request not found or not pending' });
    res.json(entry);
  } catch (err) { next(err); }
});

confirmationRouter.delete('/:id', async (req, res, next) => {
  try {
    const entry = await confirmService.denyConfirmRequest(ctx(req), req.params.id);
    if (!entry) return res.status(404).json({ error: 'Confirmation request not found or not pending' });
    res.json(entry);
  } catch (err) { next(err); }
});
