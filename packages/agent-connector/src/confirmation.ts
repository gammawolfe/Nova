import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';
import { ConfirmRequest, getConfirmTimeout } from '@nova/shared/src/confirmation';
import { QueuedTask } from '@nova/shared/src/types';
import { logger } from '@nova/shared/src/logger';
import { getAgentConfig } from './config';

function confirmDir(ctx: TenantContext): string {
  return tenantDataPath(ctx, 'confirm-queue');
}

/**
 * Check if a given intent requires confirmation for a given trust tier.
 */
export async function requiresConfirmation(ctx: TenantContext, intent: string, tier: number): Promise<boolean> {
  if (tier >= 3) return false;

  const config = await getAgentConfig(ctx);
  if (!config) return false;
  const highPrivSkills = (config.highPrivilegeSkills as string[]) ?? [];
  return highPrivSkills.includes(intent);
}

/**
 * Create a confirmation request file and return the ConfirmRequest.
 */
export async function createConfirmRequest(ctx: TenantContext, task: QueuedTask): Promise<ConfirmRequest> {
  const dir = confirmDir(ctx);
  await fsp.mkdir(dir, { recursive: true });

  const timeoutSeconds = getConfirmTimeout(task.intent);
  const id = crypto.randomUUID();

  const request: ConfirmRequest = {
    id,
    taskId: task.taskId,
    intent: task.intent,
    params: task.params,
    senderDid: task.senderDid,
    tier: task.tier as 0 | 1 | 2 | 3,
    requestedAt: new Date().toISOString(),
    timeoutAt: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
    status: 'pending',
  };

  await writeAtomicallyAsync(path.join(dir, id + '.json'), request);
  logger.info({ ctx, confirmId: id, intent: task.intent }, 'Confirmation request created');
  return request;
}

/**
 * Non-blocking check of a confirmation request status.
 * If the request has expired (past timeoutAt) and is still pending,
 * atomically updates it to 'timeout' so the admin API sees the transition.
 * Returns null if the confirmation file doesn't exist.
 */
export async function checkConfirmation(
  ctx: TenantContext,
  id: string
): Promise<'approved' | 'denied' | 'timeout' | 'pending' | null> {
  const filePath = path.join(confirmDir(ctx), id + '.json');

  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const request = JSON.parse(raw) as ConfirmRequest;

    // Check expiry
    if (request.status === 'pending' && new Date() >= new Date(request.timeoutAt)) {
      request.status = 'timeout';
      await writeAtomicallyAsync(filePath, request);
      logger.warn({ ctx, confirmId: id }, 'Confirmation timed out');
      return 'timeout';
    }

    return request.status === 'pending'
      ? 'pending'
      : request.status === 'approved'
      ? 'approved'
      : request.status === 'denied' ? 'denied' : null;
  } catch {
    return null;
  }
}

/**
 * Search for an existing pending confirmation request for a given taskId.
 * Used to handle crash-recovery: if a stalled job is re-queued,
 * we reuse the existing confirm file rather than creating a duplicate.
 * Returns the confirm ID, or null if no pending confirm exists.
 */
export async function findPendingConfirmByTaskId(
  ctx: TenantContext,
  taskId: string
): Promise<string | null> {
  const dir = confirmDir(ctx);
  try {
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const raw = await fsp.readFile(path.join(dir, file), 'utf8');
      const request = JSON.parse(raw) as ConfirmRequest;
      if (request.taskId === taskId && request.status === 'pending') {
        return request.id;
      }
    }
  } catch {
    // Directory doesn't exist or read error — no pending confirm
  }
  return null;
}
