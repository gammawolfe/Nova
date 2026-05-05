import { Router } from 'express';
import { TrustActorAddSchema, TrustActorUpdateTierSchema } from '@nova/shared';
import * as trustService from '../services/trust-service';
import { ctx } from '../middleware/ctx';

export const trustRouter = Router({ mergeParams: true });

trustRouter.post('/', async (req, res, next) => {
  try {
    const data = TrustActorAddSchema.parse(req.body);
    const actor = await trustService.addActor(ctx(req), data);
    res.status(201).json(actor);
  } catch (err) { next(err); }
});

trustRouter.get('/', async (req, res, next) => {
  try {
    res.json(await trustService.listActors(ctx(req)));
  } catch (err) { next(err); }
});

trustRouter.get('/:did', async (req, res, next) => {
  try {
    const actor = await trustService.getActor(ctx(req), decodeURIComponent(req.params.did));
    if (!actor) return res.status(404).json({ error: 'Actor not found' });
    res.json(actor);
  } catch (err) { next(err); }
});

trustRouter.patch('/:did/tier', async (req, res, next) => {
  try {
    const { tier } = TrustActorUpdateTierSchema.parse(req.body);
    const actor = await trustService.updateActorTier(ctx(req), decodeURIComponent(req.params.did), tier);
    if (!actor) return res.status(404).json({ error: 'Actor not found' });
    res.json(actor);
  } catch (err) { next(err); }
});

trustRouter.delete('/:did', async (req, res, next) => {
  try {
    const removed = await trustService.removeActor(ctx(req), decodeURIComponent(req.params.did));
    if (!removed) return res.status(404).json({ error: 'Actor not found' });
    res.json({ status: 'removed' });
  } catch (err) { next(err); }
});
