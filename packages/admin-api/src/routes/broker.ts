import { Router } from 'express';
import * as brokerService from '../services/broker-service';
import { ctx } from '../middleware/ctx';

/** Per-agent broker-mode status: mounted under /admin/tenants/:tid/agents/:aid/broker-status */
export const brokerStatusRouter = Router({ mergeParams: true });

brokerStatusRouter.get('/', async (req, res, next) => {
  try {
    res.json(await brokerService.getBrokerStatus(ctx(req)));
  } catch (err) { next(err); }
});

/** Cross-tenant summary of broker-mode agents: mounted under /admin/broker */
export const brokerSummaryRouter = Router();

brokerSummaryRouter.get('/summary', async (_req, res, next) => {
  try {
    const entries = await brokerService.getBrokerSummary();
    res.json({ entries, total: entries.length });
  } catch (err) { next(err); }
});
