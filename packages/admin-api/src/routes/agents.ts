import { Router } from 'express';
import { AgentCreateSchema, AgentUpdateSchema, AgentApprovalSchema } from '@nova/shared/src/admin-schemas';
import * as agentService from '../services/agent-service';
import * as trustService from '../services/trust-service';
import * as ucanService from '../services/ucan-service';
import { TenantContext } from '@nova/shared/src/tenant';
import { logger } from '@nova/shared/src/logger';

export const agentsRouter = Router({ mergeParams: true });

function ctx(req: any): TenantContext {
  return { tenantId: req.params.tenantId, agentId: req.params.agentId };
}

function p(req: any): { tenantId: string; agentId: string } {
  return req.params as { tenantId: string; agentId: string };
}

agentsRouter.post('/', async (req, res, next) => {
  try {
    const data = AgentCreateSchema.parse(req.body);
    const agent = await agentService.createAgent(p(req).tenantId, data);
    res.status(201).json(agent);
  } catch (err) { next(err); }
});

agentsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await agentService.listAgents(p(req).tenantId));
  } catch (err) { next(err); }
});

agentsRouter.get('/:agentId', async (req, res, next) => {
  try {
    const { tenantId, agentId } = p(req);
    const agent = await agentService.getAgent(tenantId, agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (err) { next(err); }
});

agentsRouter.patch('/:agentId', async (req, res, next) => {
  try {
    const { tenantId, agentId } = p(req);
    const updates = AgentUpdateSchema.parse(req.body) as Partial<agentService.AgentConfig>;
    const agent = await agentService.updateAgent(tenantId, agentId, updates);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (err) { next(err); }
});

agentsRouter.delete('/:agentId', async (req, res, next) => {
  try {
    const { tenantId, agentId } = p(req);
    const deleted = await agentService.deleteAgent(tenantId, agentId);
    if (!deleted) return res.status(404).json({ error: 'Agent not found' });
    res.json({ status: 'deregistered' });
  } catch (err) { next(err); }
});

// ── Agent Approval ──────────────────────────────────────────────────────────

agentsRouter.post('/:agentId/approve', async (req, res, next) => {
  try {
    const { tenantId, agentId } = p(req);
    const data = AgentApprovalSchema.parse(req.body);

    // Flip status to active
    const agent = await agentService.approveAgent(tenantId, agentId, data.notes);

    // Create trust registry entry
    if (agent.did) {
      await trustService.addActor({ tenantId, agentId }, {
        did: agent.did,
        displayName: agent.name,
        tier: data.trustTier,
        allowedSkills: data.allowedSkills,
        notes: `Auto-created on agent approval${data.notes ? ': ' + data.notes : ''}`,
      });
    }

    // Issue initial UCAN
    const ucanResult = await ucanService.issueUcan(tenantId, {
      subjectDid: agent.did ?? '',
      capabilities: data.allowedSkills.map(s => `nova:${tenantId}:${agentId}:skill:${s}`),
      expiryDays: data.ucanExpiryDays,
    });

    // Fire webhook notification to agent's replyUrl
    if (agent.replyUrl) {
      try {
        await fetch(agent.replyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'agent_approved',
            tenantId,
            agentId,
            trustTier: data.trustTier,
            ucan: ucanResult.jwt,
            ucanExpiresAt: ucanResult.expiresAt,
            ucanRenewalUrl: `http://localhost:${process.env.PORT || 3005}/admin/tenants/${tenantId}/ucans/renew`,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        logger.info({ tenantId, agentId }, 'Approval notification sent to webhook');
      } catch (err: any) {
        logger.warn({ err: err.message, tenantId, agentId }, 'Failed to send approval webhook');
      }
    }

    logger.info({ tenantId, agentId, tier: data.trustTier }, 'Agent approved');
    res.status(200).json({
      status: 'approved',
      agent,
      ucan: {
        jwt: ucanResult.jwt,
        expiresAt: ucanResult.expiresAt,
        cid: ucanResult.cid,
      },
    });
  } catch (err: any) { next(err); }
});

// ── Agent Rejection ─────────────────────────────────────────────────────────

agentsRouter.post('/:agentId/reject', async (req, res, next) => {
  try {
    const { tenantId, agentId } = p(req);
    const deleted = await agentService.rejectAgent(tenantId, agentId);
    if (!deleted) return res.status(404).json({ error: 'Agent not found or not pending' });

    logger.info({ tenantId, agentId }, 'Agent rejected');
    res.json({ status: 'rejected' });
  } catch (err: any) { next(err); }
});
