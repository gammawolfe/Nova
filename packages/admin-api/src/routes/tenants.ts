import { Router } from 'express';
import { TenantCreateSchema, TenantUpdateSchema } from '@nova/shared/src/admin-schemas';
import * as tenantService from '../services/tenant-service';

export const tenantsRouter = Router();

tenantsRouter.post('/', async (req, res, next) => {
  try {
    const data = TenantCreateSchema.parse(req.body);
    const tenant = await tenantService.createTenant(data);
    res.status(201).json(tenant);
  } catch (err) { next(err); }
});

tenantsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await tenantService.listTenants());
  } catch (err) { next(err); }
});

tenantsRouter.get('/:tenantId', async (req, res, next) => {
  try {
    const tenant = await tenantService.getTenant(req.params.tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(tenant);
  } catch (err) { next(err); }
});

tenantsRouter.patch('/:tenantId', async (req, res, next) => {
  try {
    const updates = TenantUpdateSchema.parse(req.body);
    const tenant = await tenantService.updateTenant(req.params.tenantId, updates);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(tenant);
  } catch (err) { next(err); }
});

tenantsRouter.delete('/:tenantId', async (req, res, next) => {
  try {
    const deleted = await tenantService.deleteTenant(req.params.tenantId);
    if (!deleted) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ status: 'deleted' });
  } catch (err) { next(err); }
});
