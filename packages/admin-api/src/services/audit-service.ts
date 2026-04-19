import { createReadStream } from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { AuditEvent } from '@nova/shared/src/types';
import { ID_RE } from '@nova/shared/src/validation';

function auditDir(tenantId: string): string {
  return path.join(DATA_ROOT, 'audit', tenantId);
}

function dateRange(from?: string, to?: string): string[] {
  const start = from ? new Date(from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const end = to ? new Date(to) : new Date();
  const dates: string[] = [];
  const d = new Date(start);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/**
 * Parse a single JSONL file, streaming line-by-line.
 * Returns only the events matching the given filters.
 * Memory: O(matching events in this file), not O(all events).
 */
async function readFilteredEvents(
  logFile: string,
  filters: { event?: string | undefined; taskId?: string | undefined },
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];

  let rl: readline.Interface;
  try {
    rl = readline.createInterface({
      input: createReadStream(logFile, 'utf8'),
      crlfDelay: Infinity,
    });
  } catch {
    return [];
  }

  try {
    for await (const line of rl) {
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as AuditEvent;
        if (filters.event && evt.event !== filters.event) continue;
        if (filters.taskId && evt.taskId !== filters.taskId) continue;
        events.push(evt);
      } catch { /* skip malformed lines */ }
    }
  } catch {
    // File doesn't exist or read error — return what we have
  }

  return events;
}

/**
 * Query audit logs with streaming and bounded memory.
 *
 * Processes files in reverse date order (newest first).
 * Within each day, events are appended chronologically by the audit consumer,
 * so we reverse per-day events for newest-first ordering.
 *
 * Memory: O(offset + limit) for the result buffer + O(matching events in one day)
 * for the per-file buffer. Previously was O(all matching events across all days).
 */
export async function queryAuditLogs(
  tenantId: string,
  filters: {
    event?: string | undefined; from?: string | undefined; to?: string | undefined;
    taskId?: string | undefined; limit?: number | undefined; offset?: number | undefined;
  }
): Promise<{ events: AuditEvent[]; total: number }> {
  const dir = auditDir(tenantId);
  const dates = dateRange(filters.from, filters.to).reverse(); // newest first
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  const target = offset + limit;

  const collected: AuditEvent[] = [];
  let total = 0;

  for (const date of dates) {
    const logFile = path.join(dir, `audit-${date}.jsonl`);
    const dayEvents = await readFilteredEvents(logFile, filters);

    // Reverse for newest-first within this day
    dayEvents.reverse();
    total += dayEvents.length;

    // Only accumulate events we need for the current page
    for (const evt of dayEvents) {
      if (collected.length < target) {
        collected.push(evt);
      }
      // Continue counting total even after we have enough for the page
    }
  }

  return { events: collected.slice(offset, offset + limit), total };
}

/**
 * Get all audit events for a specific task, sorted chronologically.
 * Optimized: if taskId filter matches few events per day (typical), memory is minimal.
 */
export async function getTaskAudit(tenantId: string, taskId: string): Promise<AuditEvent[]> {
  const { events } = await queryAuditLogs(tenantId, { taskId, limit: 1000 });
  // queryAuditLogs returns newest-first; task audit wants chronological
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Cross-galaxy audit aggregator: fans out queryAuditLogs across all tenants
 * in DATA_ROOT/audit, merges the per-tenant results, sorts newest-first, and
 * truncates to the caller's limit.
 *
 * `total` is the sum of per-tenant totals matching the filter — an upper
 * bound on "how many matches across all galaxies" before merge truncation.
 * Pagination (offset) is deliberately not exposed at the cross-galaxy level
 * because offset-within-sort-order is ambiguous across independent sources.
 */
export async function queryAllAuditLogs(
  filters: {
    event?: string | undefined; from?: string | undefined; to?: string | undefined;
    taskId?: string | undefined; limit?: number | undefined;
  }
): Promise<{ events: AuditEvent[]; total: number }> {
  const rootAuditDir = path.join(DATA_ROOT, 'audit');
  let tenantDirs: string[];
  try { tenantDirs = await fsp.readdir(rootAuditDir); }
  catch { return { events: [], total: 0 }; }

  const validTenants = tenantDirs.filter(d => ID_RE.test(d));
  const limit = filters.limit ?? 50;

  const perTenant = await Promise.all(
    validTenants.map(tenantId =>
      queryAuditLogs(tenantId, { ...filters, limit, offset: 0 })
        .catch(() => ({ events: [] as AuditEvent[], total: 0 })),
    ),
  );

  const merged = perTenant.flatMap(r => r.events);
  merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const totalCounted = perTenant.reduce((sum, r) => sum + r.total, 0);
  return { events: merged.slice(0, limit), total: totalCounted };
}
