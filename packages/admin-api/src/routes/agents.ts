import { Router } from 'express';
import { AgentCreateSchema, AgentUpdateSchema } from '@nova/shared/src/admin-schemas';
import * as agentService from '../services/agent-service';

export const agentsRouter = Router({ mergeParams: true });

agentsRouter.post('/', async (req, res, next) => {
  try {
    const data = AgentCreateSchema.parse(req.body);
    const agent = await agentService.createAgent(req.params.tenantId, data);
    res.status(201).json(agent);
  } catch (err) { next(err); }
});

agentsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await agentService.listAgents(req.params.tenantId));
  } catch (err) { next(err); }
});

agentsRouter.get('/:agentId', async (req, res, next) => {
  try {
    const agent = await agentService.getAgent(req.params.tenantId, req.params.agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (err) { next(err); }
});

agentsRouter.patch('/:agentId', async (req, res, next) => {
  try {
    const updates = AgentUpdateSchema.parse(req.body);
    const agent = await agentService.updateAgent(req.params.tenantId, req.params.agentId, updates);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (err) { next(err); }
});

agentsRouter.delete('/:agentId', async (req, res, next) => {
  try {
    const deleted = await agentService.deleteAgent(req.params.tenantId, req.params.agentId);
    if (!deleted) return res.status(404).json({ error: 'Agent not found' });
    res.json({ status: 'deregistered' });
  } catch (err) { next(err); }
});
