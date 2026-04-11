import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { AuditEvent } from '@nova/shared/src/types';

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

export async function queryAuditLogs(
  tenantId: string,
  filters: { event?: string; from?: string; to?: string; taskId?: string; limit?: number; offset?: number }
): Promise<{ events: AuditEvent[]; total: number }> {
  const dir = auditDir(tenantId);
  const dates = dateRange(filters.from, filters.to);
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const perFile = await Promise.all(
    dates.map(async date => {
      const logFile = path.join(dir, `audit-${date}.jsonl`);
      try {
        const content = await fsp.readFile(logFile, 'utf8');
        const events: AuditEvent[] = [];
        for (const line of content.trim().split('\n')) {
          if (!line) continue;
          try {
            const evt = JSON.parse(line) as AuditEvent;
            if (filters.event && evt.event !== filters.event) continue;
            if (filters.taskId && evt.taskId !== filters.taskId) continue;
            events.push(evt);
          } catch { /* skip malformed */ }
        }
        return events;
      } catch { return []; }
    })
  );

  const allEvents = perFile.flat().sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { events: allEvents.slice(offset, offset + limit), total: allEvents.length };
}

export async function getTaskAudit(tenantId: string, taskId: string): Promise<AuditEvent[]> {
  const { events } = await queryAuditLogs(tenantId, { taskId, limit: 1000 });
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
