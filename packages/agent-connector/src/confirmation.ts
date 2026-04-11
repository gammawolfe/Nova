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
 * Poll the confirmation file every 5s until approved, denied, or timed out.
 */
export async function waitForConfirmation(ctx: TenantContext, id: string): Promise<'approved' | 'denied' | 'timeout'> {
  const filePath = path.join(confirmDir(ctx), id + '.json');

  while (true) {
    await new Promise(r => setTimeout(r, 5000));

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const request = JSON.parse(raw) as ConfirmRequest;

      if (request.status === 'approved') return 'approved';
      if (request.status === 'denied') return 'denied';
      if (request.status === 'timeout') return 'timeout';

      // Check if deadline exceeded
      if (new Date() >= new Date(request.timeoutAt)) {
        request.status = 'timeout';
        writeAtomically(filePath, request);
        logger.warn({ ctx, confirmId: id }, 'Confirmation timed out');
        return 'timeout';
      }
    } catch (err: any) {
      logger.error({ err: err.message, confirmId: id }, 'Error reading confirmation file');
      return 'timeout';
    }
  }
}
