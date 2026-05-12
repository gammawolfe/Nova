import { Router, Request } from 'express';
import { logger } from '@nova/shared/src/logger';
import { redisKey } from '@nova/shared/src/tenant';
import { TERMINAL_STATUSES } from '@nova/shared/src/types';
import { getTaskState } from '@nova/task-queue/src/index';
import { getSharedRedis } from '@nova/shared/src/redis';
import { createSseHandler, SseEvent } from './sse-handler';

export const streamRouter = Router({ mergeParams: true });

/**
 * GET /agents/:agentId/tasks/:taskId/stream
 *
 * Server-Sent Events streaming endpoint. Replays missed events from the
 * per-task log (a sorted set scored by event id) and then forwards live
 * events via Redis pub/sub. See createSseHandler for the shared scaffold
 * (subscribe-first, replay, drain-buffered, dedup, heartbeat, cleanup).
 *
 * Per-event id space:
 *   - Each entry in the log is `{ id, type, data }` with a monotonically
 *     increasing id; Last-Event-ID is honoured for resume.
 *   - The factory dedups replay vs live by id so a publish that races our
 *     replay scan can't be delivered twice.
 *
 * Terminal-state handling: tasks that are already in a terminal status when
 * the client connects may have their terminal event in the log (replay
 * emits it and isTerminal closes) OR may have terminated before the log
 * was appended (postReplayTerminalCheck synthesises a result event from
 * the stored TaskState).
 */
streamRouter.get(
  '/tasks/:taskId/stream',
  createSseHandler({
    logTag: 'task-stream',
    channel(req: Request): string {
      const taskId = req.params['taskId']!;
      return redisKey(req.ctx, 'task-events', taskId);
    },
    async *replay(req, { lastEventId }) {
      const taskId = req.params['taskId']!;
      const logKey = redisKey(req.ctx, 'task-events-log', taskId);
      const raws = await getSharedRedis().zrangebyscore(logKey, lastEventId + 1, '+inf');
      for (const raw of raws) {
        try {
          yield JSON.parse(raw) as SseEvent;
        } catch (err: any) {
          logger.warn({ err: err.message, taskId }, 'Malformed task-events log entry');
        }
      }
    },
    parseLive(raw) {
      try {
        return JSON.parse(raw) as SseEvent;
      } catch {
        return null;
      }
    },
    isTerminal(event) {
      if (event.type === 'result' || event.type === 'error') return true;
      const status = (event.data as { status?: string } | null)?.status;
      return typeof status === 'string' && (TERMINAL_STATUSES as readonly string[]).includes(status);
    },
    async postReplayTerminalCheck(req, write) {
      const taskId = req.params['taskId']!;
      try {
        const task = await getTaskState(req.ctx, taskId);
        if (!task) {
          write({ type: 'error', data: { error: 'Task not found' } });
          return true;
        }
        if ((TERMINAL_STATUSES as readonly string[]).includes(task.status)) {
          write({ type: 'result', data: task.result ?? { status: task.status } });
          return true;
        }
      } catch (err: any) {
        logger.warn({ err: err.message, taskId }, 'task-stream: terminal-check getTaskState failed');
      }
      return false;
    },
  }),
);
