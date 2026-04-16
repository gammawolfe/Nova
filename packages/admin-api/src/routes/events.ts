import { Router, Request, Response } from 'express';
import IORedis from 'ioredis';
import { REDIS_URL } from '@nova/shared/src/redis';
import {
  AGENT_LIFECYCLE_CHANNEL,
  TENANT_LIFECYCLE_CHANNEL,
  TASK_LIFECYCLE_CHANNEL,
} from '@nova/shared/src/agent-index';
import { logger } from '@nova/shared/src/logger';

export const eventsRouter = Router();

const CHANNEL_TO_EVENT: Record<string, string> = {
  [AGENT_LIFECYCLE_CHANNEL]: 'agent',
  [TENANT_LIFECYCLE_CHANNEL]: 'tenant',
  [TASK_LIFECYCLE_CHANNEL]: 'task',
};

// A single subscriber connection fans messages out to all connected SSE clients.
// ioredis requires a dedicated connection once in subscribe mode.
let subscriber: IORedis | null = null;
const clients = new Set<Response>();

function ensureSubscriber(): IORedis {
  if (subscriber) return subscriber;
  subscriber = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  subscriber.subscribe(
    AGENT_LIFECYCLE_CHANNEL,
    TENANT_LIFECYCLE_CHANNEL,
    TASK_LIFECYCLE_CHANNEL,
    (err, count) => {
      if (err) logger.error({ err }, 'Failed to subscribe to lifecycle channels');
      else logger.info({ count }, 'SSE subscriber attached to lifecycle channels');
    },
  );
  subscriber.on('message', (channel, message) => {
    const eventName = CHANNEL_TO_EVENT[channel] ?? 'message';
    const frame = `event: ${eventName}\ndata: ${message}\n\n`;
    for (const res of clients) {
      try { res.write(frame); }
      catch { /* client already torn down; disconnect handler will clean up */ }
    }
  });
  subscriber.on('error', (err) => logger.error({ err }, 'SSE subscriber error'));
  return subscriber;
}

eventsRouter.get('/', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  ensureSubscriber();
  clients.add(res);

  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  // Heartbeat every 25s to keep proxies from closing the connection
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`); }
    catch { /* cleanup handled below */ }
  }, 25_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    clients.delete(res);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});
