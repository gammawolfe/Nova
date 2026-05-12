// packages/agent-connector/src/reclaim-worker.ts
//
// Periodic sweep for broker-mode task and reply inboxes. Two concerns,
// same cadence:
//   - reclaimAll / reclaimAllReplies:
//       Redeliver in-flight entries whose visibility timeout expired
//       (recipient stopped responding mid-task).
//   - recoverOrphansAll / recoverOrphansAllReplies:
//       Redeliver entries left in per-process holding lists by processes
//       whose heartbeat has expired (the pull side crashed between BLMOVE
//       and the claim MULTI).

import { logger } from '@nova/shared/src/logger';
import { reclaimAll, recoverOrphansAll } from '@nova/task-queue/src/index';
import * as replyInbox from '@nova/task-queue/src/reply-inbox';
import { BROKER_RECLAIM_INTERVAL_MS } from '@nova/shared/src/broker-config';

let reclaimTimer: NodeJS.Timeout | null = null;

async function reclaimTick(): Promise<void> {
  try {
    const [taskSweep, replySweep, taskOrphans, replyOrphans] = await Promise.all([
      reclaimAll(),
      replyInbox.reclaimAllReplies(),
      recoverOrphansAll(),
      replyInbox.recoverOrphansAllReplies(),
    ]);
    if (taskSweep.redelivered > 0 || taskSweep.deadLettered > 0) {
      logger.info(
        { redelivered: taskSweep.redelivered, deadLettered: taskSweep.deadLettered },
        'Broker task reclaim tick',
      );
    }
    if (replySweep.redelivered > 0 || replySweep.deadLettered > 0) {
      logger.info(
        { redelivered: replySweep.redelivered, deadLettered: replySweep.deadLettered },
        'Broker reply reclaim tick',
      );
    }
    if (taskOrphans.recovered > 0 || taskOrphans.dropped > 0) {
      logger.info(
        { recovered: taskOrphans.recovered, dropped: taskOrphans.dropped },
        'Broker task orphan sweep',
      );
    }
    if (replyOrphans.recovered > 0 || replyOrphans.dropped > 0) {
      logger.info(
        { recovered: replyOrphans.recovered, dropped: replyOrphans.dropped },
        'Broker reply orphan sweep',
      );
    }
  } catch (err: any) {
    logger.error({ err: err.message }, 'Broker reclaim tick failed');
  }
}

export function startReclaimWorker(): void {
  if (reclaimTimer) return;
  reclaimTimer = setInterval(reclaimTick, BROKER_RECLAIM_INTERVAL_MS);
  logger.info({ intervalMs: BROKER_RECLAIM_INTERVAL_MS }, 'Broker reclaim worker started');
}

export function stopReclaimWorker(): void {
  if (reclaimTimer) {
    clearInterval(reclaimTimer);
    reclaimTimer = null;
  }
}
