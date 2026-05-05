import { Router } from 'express';
import { AgentCreateSchema, AgentUpdateSchema, AgentApprovalSchema } from '@nova/shared';
import * as agentService from '../services/agent-service';
import * as trustService from '../services/trust-service';
import * as ucanService from '../services/ucan-service';
import { logger } from '@nova/shared';
import { getSharedRedis } from '@nova/shared';
import { ctx } from '../middleware/ctx';

// 24h window for the agent to poll GET /register/status after approval.
// Long enough that an operator can approve + the agent can pick up the claim
// on any reasonable timezone offset or reboot cycle; short enough that an
// abandoned claim garbage-collects before the grant itself expires (30d).
const GRANT_CLAIM_TTL_SECONDS = 24 * 3600;
function grantClaimKey(tenantId: string, agentId: string): string {
  return `nova:grant-claim:${tenantId}:${agentId}`;
}

export const agentsRouter = Router({ mergeParams: true });

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
    const updates = AgentUpdateSchema.parse(req.body) as agentService.AgentUpdateInput;
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

    // Create trust registry entry for the agent itself
    if (agent.did) {
      await trustService.addActor({ tenantId, agentId }, {
        did: agent.did,
        displayName: agent.name,
        tier: data.trustTier,
        allowedSkills: data.allowedSkills,
        notes: `Auto-created on agent approval${data.notes ? ': ' + data.notes : ''}`,
      });
    }

    // Issue the approval grant — broad tenant-scope capability. The sender
    // uses this as the root-of-trust in the prf chain of every invocation
    // token it mints locally. Per-skill narrowing is enforced at the
    // destination's own registered skill list, not at the grant layer.
    const grant = await ucanService.issueApprovalGrant(tenantId, {
      subjectDid: agent.did ?? '',
      capabilities: [`nova:${tenantId}:*`],
      expiryDays: data.ucanExpiryDays,
    });

    // Stash grant for one-time claim via GET /register/status (for stdio MCP
    // clients without a webhook listener).
    await getSharedRedis().set(
      grantClaimKey(tenantId, agentId),
      JSON.stringify({
        jwt: grant.jwt,
        cid: grant.cid,
        expiresAt: grant.expiresAt,
        trustTier: data.trustTier,
      }),
      'EX',
      GRANT_CLAIM_TTL_SECONDS,
    );

    // Fire webhook notification to agent's replyUrl (still supported for agents that listen)
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
            grant: grant.jwt,
            grantExpiresAt: grant.expiresAt,
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
      grant: {
        jwt: grant.jwt,
        expiresAt: grant.expiresAt,
        cid: grant.cid,
      },
    });
  } catch (err: any) { next(err); }
});

// ── UCAN Reissue (operator recovery path) ───────────────────────────────────

/**
 * POST /admin/tenants/:tenantId/agents/:agentId/ucans/reissue
 *
 * Operator recovery for the one-time UCAN claim. Use when an already-approved
 * agent missed its claim window (Redis TTL expired) or lost the claim before
 * the local runtime could cache it. Idempotent: overwrites any pending claim
 * with a fresh UCAN and a fresh TTL.
 *
 * Capabilities are recovered from the trust-registry entry seeded at approval.
 * Deliberately does not return the JWT in the HTTP response — the credential
 * is handed to the agent via the same one-time-claim path as approval, so
 * operator UIs never hold the token in transit.
 */
agentsRouter.post('/:agentId/ucans/reissue', async (req, res, next) => {
  try {
    const { tenantId, agentId } = p(req);
    const result = await ucanService.reissueGrant(tenantId, agentId);

    await getSharedRedis().set(
      grantClaimKey(tenantId, agentId),
      JSON.stringify({
        jwt: result.jwt,
        cid: result.cid,
        expiresAt: result.expiresAt,
        trustTier: result.trustTier,
      }),
      'EX',
      GRANT_CLAIM_TTL_SECONDS,
    );

    logger.info(
      { tenantId, agentId, cid: result.cid, tier: result.trustTier },
      'Grant reissued for claim pickup',
    );
    res.status(200).json({
      status: 'reissued',
      tenantId,
      agentId,
      expiresAt: result.expiresAt,
      cid: result.cid,
      trustTier: result.trustTier,
      allowedSkills: result.allowedSkills,
      nextStep: 'Agent should call GET /register/status (or nova_check_registration) to pick up the fresh grant.',
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
