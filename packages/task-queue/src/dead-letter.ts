import crypto from 'crypto';
import path from 'path';
import { TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { TaskResult } from '@nova/shared/src/types';
import { writeAtomically } from '@nova/shared/src/fs-utils';
import { logger } from '@nova/shared/src/logger';

const DEAD_LETTER_TTL_DAYS = parseInt(process.env.DEAD_LETTER_TTL_DAYS || '7', 10);

export interface DeadLetterEntry {
  id: string;
  tenantId: string;
  agentId: string;
  taskId: string;
  targetUrl: string;
  taskResult: TaskResult;
  failureReason: 'http_4xx' | 'exhausted_retries';
  lastAttemptAt: string;
  attemptCount: number;
  httpStatus: number;
  createdAt: string;
  expiresAt: string;
}

/**
 * Write a failed delivery to the dead letter store.
 * Called when delivery returns HTTP 4xx or after retry exhaustion.
 */
export function writeDeadLetter(
  ctx: TenantContext,
  params: {
    taskId: string;
    targetUrl: string;
    taskResult: TaskResult;
    failureReason: DeadLetterEntry['failureReason'];
    httpStatus: number;
    attemptCount: number;
  }
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + DEAD_LETTER_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const entry: DeadLetterEntry = {
    id,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    taskId: params.taskId,
    targetUrl: params.targetUrl,
    taskResult: params.taskResult,
    failureReason: params.failureReason,
    lastAttemptAt: now,
    attemptCount: params.attemptCount,
    httpStatus: params.httpStatus,
    createdAt: now,
    expiresAt,
  };

  const filePath = path.join(tenantDataPath(ctx, 'dead-letter'), id + '.json');
  writeAtomically(filePath, entry);

  logger.warn({
    ctx,
    deadLetterId: id,
    taskId: params.taskId,
    failureReason: params.failureReason,
    httpStatus: params.httpStatus,
  }, 'Task delivery written to dead letter store');

  return id;
}
