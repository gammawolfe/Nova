import fsp from 'fs/promises';
import path from 'path';
import { TenantContext, tenantDataPath } from '@nova/shared';
import { writeAtomicallyAsync } from '@nova/shared';
import { QuarantineEntry } from '@nova/shared';

function quarantineDir(ctx: TenantContext): string {
  return tenantDataPath(ctx, 'quarantine');
}

export async function listQuarantine(ctx: TenantContext, limit = 50, offset = 0): Promise<{ entries: QuarantineEntry[]; total: number }> {
  const dir = quarantineDir(ctx);
  let files: string[];
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')).sort().reverse(); }
  catch { return { entries: [], total: 0 }; }

  const total = files.length;
  const page = files.slice(offset, offset + limit);

  const entries = (await Promise.all(
    page.map(async f => {
      try { return JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) as QuarantineEntry; }
      catch { return null; }
    })
  )).filter((e): e is QuarantineEntry => e !== null);

  return { entries, total };
}

export async function getQuarantineEntry(ctx: TenantContext, id: string): Promise<QuarantineEntry | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(quarantineDir(ctx), id + '.json'), 'utf8'));
  } catch { return null; }
}

export async function releaseQuarantineEntry(ctx: TenantContext, id: string, reviewedBy = 'admin'): Promise<QuarantineEntry | null> {
  const entry = await getQuarantineEntry(ctx, id);
  if (!entry) return null;
  entry.status = 'released';
  entry.reviewedAt = new Date().toISOString();
  entry.reviewedBy = reviewedBy;
  await writeAtomicallyAsync(path.join(quarantineDir(ctx), id + '.json'), entry);
  return entry;
}

export async function dropQuarantineEntry(ctx: TenantContext, id: string, reviewedBy = 'admin'): Promise<QuarantineEntry | null> {
  const entry = await getQuarantineEntry(ctx, id);
  if (!entry) return null;
  entry.status = 'dropped';
  entry.reviewedAt = new Date().toISOString();
  entry.reviewedBy = reviewedBy;
  await writeAtomicallyAsync(path.join(quarantineDir(ctx), id + '.json'), entry);
  return entry;
}

export async function quarantineStats(ctx: TenantContext): Promise<{ total: number; pending: number; released: number; dropped: number }> {
  const dir = quarantineDir(ctx);
  let files: string[];
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')); }
  catch { return { total: 0, pending: 0, released: 0, dropped: 0 }; }

  let pending = 0, released = 0, dropped = 0;
  await Promise.all(
    files.map(async f => {
      try {
        const entry = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) as QuarantineEntry;
        if (entry.status === 'pending_review') pending++;
        else if (entry.status === 'released') released++;
        else if (entry.status === 'dropped') dropped++;
      } catch { /* skip corrupt */ }
    })
  );

  return { total: files.length, pending, released, dropped };
}
