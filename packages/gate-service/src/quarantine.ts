import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { TenantContext, tenantDataPath } from '@nova/shared';
import { writeAtomicallyAsync } from '@nova/shared';
import { logger } from '@nova/shared';
import { QuarantineEntry } from '@nova/shared';

export type { QuarantineEntry };

const QUARANTINE_MAX_ENTRIES = parseInt(process.env.QUARANTINE_MAX_ENTRIES || '10000', 10);
const QUARANTINE_ALERT_THRESHOLD = parseInt(process.env.QUARANTINE_ALERT_THRESHOLD || '500', 10);
const QUARANTINE_TTL_DAYS = parseInt(process.env.QUARANTINE_TTL_DAYS || '30', 10);

/**
 * Write a quarantine entry to the tenant's quarantine store.
 * Returns the quarantine entry ID, or null if the store is full.
 */
export async function writeQuarantine(
  ctx: TenantContext,
  entry: Omit<QuarantineEntry, 'id' | 'tenantId' | 'agentId' | 'status' | 'reviewedAt' | 'reviewedBy'>
): Promise<string | null> {
  const quarantineDir = tenantDataPath(ctx, 'quarantine');
  await fsp.mkdir(quarantineDir, { recursive: true });

  // Check size bounds
  let existingCount = 0;
  try {
    existingCount = (await fsp.readdir(quarantineDir)).filter(f => f.endsWith('.json')).length;
  } catch {
    existingCount = 0;
  }

  if (existingCount >= QUARANTINE_MAX_ENTRIES) {
    logger.error({ ctx, count: existingCount }, 'Quarantine store full — dropping entry');
    return null; // Caller should emit quarantine_full audit event
  }

  if (existingCount >= QUARANTINE_ALERT_THRESHOLD) {
    logger.warn({ ctx, count: existingCount, threshold: QUARANTINE_ALERT_THRESHOLD },
      'Quarantine alert threshold reached');
  }

  const id = crypto.randomUUID();
  const full: QuarantineEntry = {
    id,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    status: 'pending_review',
    reviewedAt: null,
    reviewedBy: null,
    ...entry,
  };

  const filePath = path.join(quarantineDir, id + '.json');
  await writeAtomicallyAsync(filePath, full);

  logger.info({ ctx, quarantineId: id, step: entry.gateStep, reason: entry.reason }, 'Task quarantined');
  return id;
}

/**
 * Evict entries older than QUARANTINE_TTL_DAYS.
 * Call from a periodic cleanup job (e.g. daily cron in M3).
 */
export async function evictOldQuarantineEntries(ctx: TenantContext): Promise<number> {
  const quarantineDir = tenantDataPath(ctx, 'quarantine');

  let files: string[];
  try {
    files = (await fsp.readdir(quarantineDir)).filter(f => f.endsWith('.json'));
  } catch {
    return 0;
  }

  const cutoff = new Date(Date.now() - QUARANTINE_TTL_DAYS * 24 * 60 * 60 * 1000);
  let evicted = 0;

  for (const file of files) {
    const filePath = path.join(quarantineDir, file);
    try {
      const entry: QuarantineEntry = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      if (new Date(entry.receivedAt) < cutoff) {
        await fsp.unlink(filePath);
        evicted++;
      }
    } catch {
      // Skip corrupt files
    }
  }

  if (evicted > 0) {
    logger.info({ ctx, evicted }, 'Evicted old quarantine entries');
  }
  return evicted;
}
