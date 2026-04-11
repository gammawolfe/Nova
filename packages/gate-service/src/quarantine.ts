import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { writeAtomically } from '@nova/shared/src/fs-utils';
import { logger } from '@nova/shared/src/logger';

const QUARANTINE_MAX_ENTRIES = parseInt(process.env.QUARANTINE_MAX_ENTRIES || '10000', 10);
const QUARANTINE_ALERT_THRESHOLD = parseInt(process.env.QUARANTINE_ALERT_THRESHOLD || '500', 10);
const QUARANTINE_TTL_DAYS = parseInt(process.env.QUARANTINE_TTL_DAYS || '30', 10);

export interface QuarantineEntry {
  id: string;
  tenantId: string;
  agentId: string;
  receivedAt: string;
  senderDid: string | null;
  rawTask: unknown;
  gateStep: 'tier' | 'ucan' | 'schema' | 'classifier';
  reason: string;
  status: 'pending_review' | 'released' | 'dropped';
  reviewedAt: string | null;
  reviewedBy: string | null;
}

/**
 * Write a quarantine entry to the tenant's quarantine store.
 * Returns the quarantine entry ID, or null if the store is full.
 */
export function writeQuarantine(
  ctx: TenantContext,
  entry: Omit<QuarantineEntry, 'id' | 'tenantId' | 'agentId' | 'status' | 'reviewedAt' | 'reviewedBy'>
): string | null {
  const quarantineDir = tenantDataPath(ctx, 'quarantine');
  fs.mkdirSync(quarantineDir, { recursive: true });

  // Check size bounds
  let existingCount = 0;
  try {
    existingCount = fs.readdirSync(quarantineDir).filter(f => f.endsWith('.json')).length;
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
  writeAtomically(filePath, full);

  logger.info({ ctx, quarantineId: id, step: entry.gateStep, reason: entry.reason }, 'Task quarantined');
  return id;
}

/**
 * Evict entries older than QUARANTINE_TTL_DAYS.
 * Call from a periodic cleanup job (e.g. daily cron in M3).
 */
export function evictOldQuarantineEntries(ctx: TenantContext): number {
  const quarantineDir = tenantDataPath(ctx, 'quarantine');
  if (!fs.existsSync(quarantineDir)) return 0;

  const cutoff = new Date(Date.now() - QUARANTINE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const files = fs.readdirSync(quarantineDir).filter(f => f.endsWith('.json'));

  let evicted = 0;
  for (const file of files) {
    const filePath = path.join(quarantineDir, file);
    try {
      const entry: QuarantineEntry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (new Date(entry.receivedAt) < cutoff) {
        fs.unlinkSync(filePath);
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
