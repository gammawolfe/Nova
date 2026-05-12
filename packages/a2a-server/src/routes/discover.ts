// packages/a2a-server/src/routes/discover.ts
//
// Public discovery endpoints. Returns active-agent metadata so MCP
// clients can find capable senders/receivers without prior knowledge
// of agentIds. No auth — the index already exposes only `active` agents
// with a public surface (name, skills, did).

import { Router, Request, Response } from 'express';
import { logger } from '@nova/shared/src/logger';
import { getSharedRedis } from '@nova/shared/src/redis';
import { listActiveAgentMeta, getAgentMeta } from '@nova/shared/src/agent-index';

export const discoverRouter = Router();

discoverRouter.get('/discover', async (req: Request, res: Response) => {
  try {
    const redis = getSharedRedis();
    let agents = await listActiveAgentMeta(redis);

    const statusFilter = req.query.status as string;
    if (statusFilter && statusFilter !== 'all') {
      agents = agents.filter(agent => agent.status === statusFilter);
    }

    const skillsFilter = req.query.skills as string;
    if (skillsFilter) {
      agents = agents.filter(agent =>
        agent.skills.some(skill =>
          skill.id.includes(skillsFilter) ||
          skill.name.includes(skillsFilter) ||
          (skill.tags && skill.tags.includes(skillsFilter))
        )
      );
    }
    res.json(agents);
  } catch (err) {
    logger.error({ err }, 'Failed to list agents for discovery');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve agent list' });
  }
});

discoverRouter.get('/discover/:agentId', async (req: Request, res: Response) => {
  const agentId = req.params['agentId'];
  if (!agentId) return res.status(400).json({ error: 'AGENT_ID_REQUIRED' });
  try {
    const redis = getSharedRedis();
    const agent = await getAgentMeta(redis, agentId);
    if (!agent) {
      return res.status(404).json({ error: 'AGENT_NOT_FOUND', message: `Agent ${agentId} not found` });
    }
    res.json(agent);
  } catch (err) {
    logger.error({ err }, `Failed to retrieve agent ${agentId}`);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve agent details' });
  }
});
