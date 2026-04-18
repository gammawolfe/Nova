import { Router, Request, Response, NextFunction } from 'express';
import * as agentService from '../services/agent-service';

export const allAgentsRouter = Router();

allAgentsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const agents = await agentService.listAllActiveAgents();
    res.json({ agents, total: agents.length });
  } catch (err) { next(err); }
});
