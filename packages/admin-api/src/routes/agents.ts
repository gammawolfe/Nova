import { Router } from 'express';
import { AgentCreateSchema, AgentUpdateSchema } from '@nova/shared/src/admin-schemas';
import * as agentService from '../services/agent-service';

export const agentsRouter = Router({ mergeParams: true });

// mergeParams: true makes parent :tenantId available but TypeScript
// doesn't model merged params — cast to access them safely.
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
    const updates = AgentUpdateSchema.parse(req.body);
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
