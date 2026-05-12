import IORedis from 'ioredis';
import { Router, Request, Response } from 'express';
import { logger } from '@nova/shared/src/logger';
import { redisKey } from '@nova/shared/src/tenant';
import { TERMINAL_STATUSES } from '@nova/shared/src/types';
import { getTaskState } from '@nova/task-queue/src/index';
import { getSharedRedis } from '@nova/shared/src/redis';

const redis = getSharedRedis();
import { activeSseStreams } from './metrics';
import { registerSseCleanup } from './sse-registry';

export const streamRouter = Router({ mergeParams: true });

const HEARTBEAT_INTERVAL_MS = 15_000;

function sendSSEEvent(res: Response, event: { id?: number; type: string; data: unknown }): void {
  if (event.id !== undefined) res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  // Flush immediately so the client sees it right away
  if (typeof (res as any).flush === 'function') {
    (res as any).flush();
  }
}

/**
 * GET /agents/:agentId/tasks/:taskId/stream
 *
 * Server-Sent Events streaming endpoint.
 * Replays missed events using Last-Event-ID header, then streams live events via Redis pub/sub.
 * Sends a heartbeat every 15 seconds to keep the connection alive.
 */
streamRouter.get('/tasks/:taskId/stream', async (req: Request, res: Response) => {
  const taskId = req.params['taskId'];
  if (!taskId) return res.status(400).json({ error: 'Missing taskId' });

  const ctx = req.ctx;

  // Set SSE response headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx/Caddy buffering
  res.flushHeaders();

  let cleaned = false;
  activeSseStreams.inc();
  const lastEventId = parseInt((req.headers['last-event-id'] as string) ?? '0', 10);
  const logKey = redisKey(ctx, 'task-events-log', taskId);
  const channelKey = redisKey(ctx, 'task-events', taskId);

  // Replay missed events from sorted set (events with id > lastEventId)
  let missedCount = 0;
  try {
    const missed = await redis.zrangebyscore(logKey, lastEventId + 1, '+inf');
    for (const item of missed) {
      const parsed = JSON.parse(item) as { id: number; type: string; data: unknown };
      sendSSEEvent(res, parsed);
      missedCount++;
    }
  } catch (err: any) {
    logger.warn({ err: err.message, taskId }, 'Failed to replay SSE events');
  }

  // Check if task is already terminal — send result and close
  try {
    const task = await getTaskState(ctx, taskId);
    if (!task) {
      sendSSEEvent(res, {
        id: lastEventId + missedCount + 1,
        type: 'error',
        data: { error: 'Task not found' },
      });
      return res.end();
    }

    if ((TERMINAL_STATUSES as readonly string[]).includes(task.status)) {
      sendSSEEvent(res, {
        id: lastEventId + missedCount + 1,
        type: 'result',
        data: task.result ?? { status: task.status },
      });
      return res.end();
    }
  } catch (err: any) {
    logger.warn({ err: err.message, taskId }, 'Failed to check task state for SSE');
  }

  // Subscribe to Redis pub/sub for live events
  // IMPORTANT: pub/sub requires a dedicated connection
  let sub: IORedis | null = null;
  try {
    sub = redis.duplicate();
    await sub.subscribe(channelKey);
  } catch (err: any) {
    logger.error({ err: err.message, taskId }, 'Failed to subscribe to SSE channel');
    return res.end();
  }

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      sendSSEEvent(res, {
        type: 'heartbeat',
        data: { timestamp: new Date().toISOString() },
      });
    } catch {
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    activeSseStreams.dec();
    clearInterval(heartbeat);
    unregister();
    if (sub) {
      sub.unsubscribe().catch(() => {});
      sub.quit().catch(() => {});
      sub = null;
    }
  }

  // H1 — register with the live-stream registry so graceful shutdown can
  // drain this connection cleanly. unregister() is called from cleanup()
  // above so a natural close doesn't leak a closure into the registry.
  const unregister = registerSseCleanup(cleanup);

  sub.on('message', (_channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as { id: number; type: string; data: unknown };
      sendSSEEvent(res, event);

      const status = (event.data as any)?.status;
      if ((TERMINAL_STATUSES as readonly string[]).includes(status)) {
        cleanup();
        res.end();
      }
    } catch (err: any) {
      logger.warn({ err: err.message, taskId }, 'Failed to parse SSE pub/sub message');
    }
  });

  sub.on('error', (err) => {
    logger.error({ err: err.message, taskId }, 'SSE Redis subscriber error');
    cleanup();
    res.end();
  });

  // Cleanup when client disconnects
  req.on('close', () => {
    cleanup();
  });
});
