import { Router } from 'express';
import { PaginationSchema } from '@nova/shared';
import { enqueueWithIdempotency } from '@nova/task-queue';
import { QueuedTaskSchema } from '@nova/shared';
import * as quarantineService from '../services/quarantine-service';
import { ctx } from '../middleware/ctx';

export const quarantineRouter = Router({ mergeParams: true });

quarantineRouter.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = PaginationSchema.parse(req.query);
    res.json(await quarantineService.listQuarantine(ctx(req), limit, offset));
  } catch (err) { next(err); }
});

quarantineRouter.get('/stats', async (req, res, next) => {
  try {
    res.json(await quarantineService.quarantineStats(ctx(req)));
  } catch (err) { next(err); }
});

quarantineRouter.get('/:id', async (req, res, next) => {
  try {
    const entry = await quarantineService.getQuarantineEntry(ctx(req), req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json(entry);
  } catch (err) { next(err); }
});

quarantineRouter.post('/:id/release', async (req, res, next) => {
  try {
    const c = ctx(req);
    const entry = await quarantineService.releaseQuarantineEntry(c, req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    // Re-enqueue the task — validate against schema before touching the queue
    if (entry.rawTask && typeof entry.rawTask === 'object') {
      const parsed = QueuedTaskSchema.safeParse({
        ...(entry.rawTask as object),
        tenantId: c.tenantId,
        agentId: c.agentId,
      });
      if (!parsed.success) {
        return res.status(422).json({ error: 'Quarantined task data is invalid', details: parsed.error.issues });
      }
      await enqueueWithIdempotency(c, parsed.data, 600);
    }

    res.json(entry);
  } catch (err) { next(err); }
});

quarantineRouter.delete('/:id', async (req, res, next) => {
  try {
    const entry = await quarantineService.dropQuarantineEntry(ctx(req), req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json(entry);
  } catch (err) { next(err); }
});
