import { Router, Request, Response } from 'express';
import * as agentService from '../services/agent-service';
import { DiscoverQuerySchema } from '@nova/shared';
import { ParsedAgentMeta } from '@nova/shared';

export const discoverRouter = Router();

function toPublicAgent(a: ParsedAgentMeta, baseUrl: string) {
  return {
    agentId: a.agentId,
    name: a.name,
    description: a.description,
    url: `${baseUrl}/agents/${a.agentId}`,
    skills: a.skills.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
    })),
    status: a.status,
    capabilities: a.capabilities,
  };
}

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

    if (query.agentId) {
      agents = agents.filter(a => a.agentId === query.agentId);
    }

    if (query.skills) {
      const skillFilter = query.skills.toLowerCase();
      agents = agents.filter(a =>
        a.skills.some(s => s.id.toLowerCase().includes(skillFilter) || s.name.toLowerCase().includes(skillFilter))
      );
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const publicAgents = agents.map(a => toPublicAgent(a, baseUrl));

    res.json({
      agents: publicAgents,
      total: publicAgents.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

/**
 * GET /discover/:agentId — lookup specific agent (O(1) Redis call)
 */
discoverRouter.get('/:agentId', async (req: Request, res: Response) => {
  try {
    const agentId = req.params['agentId'];
    if (!agentId) return res.status(400).json({ error: 'MISSING_AGENT_ID' });
    const agent = await agentService.getActiveAgent(agentId);

    if (!agent) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(toPublicAgent(agent, baseUrl));
  } catch (err: any) {
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});
