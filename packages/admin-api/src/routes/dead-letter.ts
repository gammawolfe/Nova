import { Router } from 'express';
import { TenantContext } from '@nova/shared/src/tenant';
import { PaginationSchema } from '@nova/shared/src/admin-schemas';
import * as dlService from '../services/dead-letter-service';

export const deadLetterRouter = Router({ mergeParams: true });

function ctx(req: any): TenantContext {
  return { tenantId: req.params.tenantId, agentId: req.params.agentId };
}

deadLetterRouter.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = PaginationSchema.parse(req.query);
    res.json(await dlService.listDeadLetters(ctx(req), limit, offset));
  } catch (err) { next(err); }
});

deadLetterRouter.get('/:id', async (req, res, next) => {
  try {
    const entry = await dlService.getDeadLetter(ctx(req), req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json(entry);
  } catch (err) { next(err); }
});

deadLetterRouter.delete('/:id', async (req, res, next) => {
  try {
    const acked = await dlService.acknowledgeDeadLetter(ctx(req), req.params.id);
    if (!acked) return res.status(404).json({ error: 'Entry not found' });
    res.json({ status: 'acknowledged' });
  } catch (err) { next(err); }
});
