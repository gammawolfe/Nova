import { Router } from 'express';
import { AuditQuerySchema } from '@nova/shared/src/admin-schemas';
import * as auditService from '../services/audit-service';

export const auditRouter = Router({ mergeParams: true });

auditRouter.get('/', async (req, res, next) => {
  try {
    const filters = AuditQuerySchema.parse(req.query);
    res.json(await auditService.queryAuditLogs(req.params.tenantId, filters));
  } catch (err) { next(err); }
});

auditRouter.get('/:taskId', async (req, res, next) => {
  try {
    const events = await auditService.getTaskAudit(req.params.tenantId, req.params.taskId);
    res.json(events);
  } catch (err) { next(err); }
});
