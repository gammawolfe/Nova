import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { writeAtomically } from '@nova/shared/src/fs-utils';
import { ConfirmRequest, getConfirmTimeout } from '@nova/shared/src/confirmation';
import { QueuedTask } from '@nova/shared/src/types';
import { logger } from '@nova/shared/src/logger';

function confirmDir(ctx: TenantContext): string {
  return tenantDataPath(ctx, 'confirm-queue');
}

/**
 * Check if a given intent requires confirmation for a given trust tier.
 */
export function requiresConfirmation(ctx: TenantContext, intent: string, tier: number): boolean {
  // Tier 3 (fully trusted) skips confirmation
  if (tier >= 3) return false;

  try {
    const configPath = tenantDataPath(ctx, 'agent-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const highPrivSkills: string[] = config.highPrivilegeSkills ?? [];
    return highPrivSkills.includes(intent);
  } catch {
    return false;
  }
}

/**
 * Create a confirmation request file and return the ConfirmRequest.
 */
export function createConfirmRequest(ctx: TenantContext, task: QueuedTask): ConfirmRequest {
  const dir = confirmDir(ctx);
  fs.mkdirSync(dir, { recursive: true });

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

  writeAtomically(path.join(dir, id + '.json'), request);
  logger.info({ ctx, confirmId: id, intent: task.intent }, 'Confirmation request created');
  return request;
}

/**
 * Non-blocking check of a confirmation request status.
 * Reads the file synchronously (fast, small JSON).
 * If the request has expired (past timeoutAt) and is still pending,
 * atomically updates it to 'timeout' so the admin API sees the transition.
 * Returns null if the confirmation file doesn't exist.
 */
export function checkConfirmation(
  ctx: TenantContext,
  id: string
): 'approved' | 'denied' | 'timeout' | 'pending' | null {
  const filePath = path.join(confirmDir(ctx), id + '.json');

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const request = JSON.parse(raw) as ConfirmRequest;

    // Check expiry
    if (request.status === 'pending' && new Date() >= new Date(request.timeoutAt)) {
      request.status = 'timeout';
      writeAtomically(filePath, request);
      request.status = 'timeout';  // update in-memory for return
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
export function findPendingConfirmByTaskId(
  ctx: TenantContext,
  taskId: string
): string | null {
  const dir = confirmDir(ctx);
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(dir, file), "utf8");
      const request = JSON.parse(raw) as ConfirmRequest;
      if (request.taskId === taskId && request.status === "pending") {
        return request.id;
      }
    }
  } catch {
    // Directory doesn't exist or read error — no pending confirm
  }
  return null;
}
