import { Router, Request, Response, NextFunction } from 'express';
import { AuditQuerySchema } from '@nova/shared/src/admin-schemas';
import * as auditService from '../services/audit-service';

export const allAuditRouter = Router();

allAuditRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = AuditQuerySchema.parse(req.query);
    const { events, total } = await auditService.queryAllAuditLogs({
      event: filters.event,
      from: filters.from,
      to: filters.to,
      taskId: filters.taskId,
      limit: filters.limit,
    });
    res.json({ events, total });
  } catch (err) { next(err); }
});
