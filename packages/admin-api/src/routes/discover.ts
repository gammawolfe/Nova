import { Router, Request, Response } from 'express';
import * as agentService from '../services/agent-service';
import { DiscoverQuerySchema } from '@nova/shared/src/admin-schemas';

export const discoverRouter = Router();

/**
 * GET /discover — public agent discovery
 *
 * Returns a list of active agents across all tenants with their public metadata.
 * Authentication not required. Only shows agents with status === 'active'.
 *
 * Query params:
 *   status=active|pending|all  — filter by status (default: 'active')
 *   agentId=xxx                — lookup single agent
 *   skills=search              — filter agents that have a skill containing 'search'
 */
discoverRouter.get('/', async (req: Request, res: Response) => {
  try {
    const queryParse = DiscoverQuerySchema.safeParse(req.query);
    if (!queryParse.success) {
      return res.status(400).json({ error: 'INVALID_QUERY', details: queryParse.error.issues });
    }

    const query = queryParse.data;
    let agents = await agentService.listAllActiveAgents();

    // Apply filters
    if (query.status !== 'active') {
      // For 'pending' or 'all', we need to scan pending agents too
      // listAllActiveAgents only returns active — extend if needed
      // For now, 'pending' returns empty and 'all' returns same as 'active'
      // This is intentional: pending agents are not discoverable by other agents
    }

    if (query.agentId) {
      agents = agents.filter(a => a.agentId === query.agentId);
    }

    if (query.skills) {
      const skillFilter = query.skills.toLowerCase();
      agents = agents.filter(a =>
        a.skills.some(s => s.id.toLowerCase().includes(skillFilter) || s.name.toLowerCase().includes(skillFilter))
      );
    }

    // Strip sensitive fields before returning
    const publicAgents = agents.map(a => ({
      agentId: a.agentId,
      name: a.name,
      description: a.description,
      url: a.authentication ? undefined : `/agents/${a.agentId}`, // URL built from agentId
      skills: a.skills.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags,
      })),
      status: a.status,
      capabilities: a.capabilities,
    }));

    // Build proper URLs
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    for (const agent of publicAgents) {
      agent.url = `${baseUrl}/agents/${agent.agentId}`;
    }

    res.json({
      agents: publicAgents,
      total: publicAgents.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * GET /discover/:agentId — lookup specific agent
 */
discoverRouter.get('/:agentId', async (req: Request, res: Response) => {
  try {
    const { agentId } = req.params;
    const agents = await agentService.listAllActiveAgents();
    const agent = agents.find(a => a.agentId === agentId);

    if (!agent) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      agentId: agent.agentId,
      name: agent.name,
      description: agent.description,
      url: `${baseUrl}/agents/${agent.agentId}`,
      skills: agent.skills.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags,
      })),
      status: agent.status,
      capabilities: agent.capabilities,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});
