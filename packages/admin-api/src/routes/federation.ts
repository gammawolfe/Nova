import { Router } from 'express';
import { FederationGrantIssueSchema } from '@nova/shared/src/admin-schemas';
import * as ucanService from '../services/ucan-service';

/**
 * Federation routes — Nova-level (not tenant-scoped), live under
 * `/admin/federation/`. The admin auth middleware mounted in index.ts
 * runs ahead of this router; we don't reapply it here.
 *
 * Revocation re-uses the existing per-tenant `POST .../ucans/revoke` by CID:
 * federation grants are stored alongside tenant approval grants under
 * `data/ucans/issued/` and the existing revoke walks the whole directory.
 * Operators revoke a federation grant the same way they revoke any UCAN.
 */
export const federationRouter = Router();

// POST /admin/federation/grants — mint a Nova-to-peer-Nova delegation.
// Response includes the JWT, which is the artifact the operator hands to
// the peer's operator (out-of-band — Nova does not push to the peer).
federationRouter.post('/grants', async (req, res, next) => {
  try {
    const data = FederationGrantIssueSchema.parse(req.body);
    const result = await ucanService.issueFederationGrant(data);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

// GET /admin/federation/grants — list issued federation grants (metadata only).
federationRouter.get('/grants', async (_req, res, next) => {
  try {
    res.json(await ucanService.listFederationGrants());
  } catch (err) { next(err); }
});
