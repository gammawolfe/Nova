import { Router } from 'express';
import { UcanIssueSchema, UcanRevokeSchema } from '@nova/shared/src/admin-schemas';
import * as ucanService from '../services/ucan-service';

export const ucanRouter = Router({ mergeParams: true });

ucanRouter.post('/issue', async (req, res, next) => {
  try {
    const data = UcanIssueSchema.parse(req.body);
    const result = await ucanService.issueUcan(req.params.tenantId, data);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

ucanRouter.post('/revoke', async (req, res, next) => {
  try {
    const { cid } = UcanRevokeSchema.parse(req.body);
    const revoked = await ucanService.revokeUcan(cid);
    if (!revoked) return res.status(404).json({ error: 'UCAN not found' });
    res.json({ status: 'revoked', cid });
  } catch (err) { next(err); }
});

ucanRouter.get('/', async (req, res, next) => {
  try {
    const expiringWithin = req.query.expiring_within as string | undefined;
    res.json(await ucanService.listUcans(req.params.tenantId, expiringWithin));
  } catch (err) { next(err); }
});
