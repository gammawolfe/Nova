import { Router } from 'express';
import { AuditQuerySchema } from '@nova/shared';
import * as auditService from '../services/audit-service';

export const auditRouter = Router({ mergeParams: true });

function tenantId(req: any): string {
  return (req.params as { tenantId: string }).tenantId;
}

auditRouter.get('/', async (req, res, next) => {
  try {
    const filters = AuditQuerySchema.parse(req.query);
    res.json(await auditService.queryAuditLogs(tenantId(req), filters));
  } catch (err) { next(err); }
});

auditRouter.get('/:taskId', async (req, res, next) => {
  try {
    const events = await auditService.getTaskAudit(tenantId(req), req.params.taskId);
    res.json(events);
  } catch (err) { next(err); }
});
