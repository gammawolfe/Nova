import fsp from 'fs/promises';
import path from 'path';
import { TenantContext, tenantDataPath } from '@nova/shared';
import { DeadLetterEntry } from '@nova/shared';

function dlDir(ctx: TenantContext): string {
  return tenantDataPath(ctx, 'dead-letter');
}

export async function listDeadLetters(ctx: TenantContext, limit = 50, offset = 0): Promise<{ entries: DeadLetterEntry[]; total: number }> {
  const dir = dlDir(ctx);
  let files: string[];
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')).sort().reverse(); }
  catch { return { entries: [], total: 0 }; }

  const total = files.length;
  const page = files.slice(offset, offset + limit);

  const entries = (await Promise.all(
    page.map(async f => {
      try { return JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) as DeadLetterEntry; }
      catch { return null; }
    })
  )).filter((e): e is DeadLetterEntry => e !== null);

  return { entries, total };
}

export async function getDeadLetter(ctx: TenantContext, id: string): Promise<DeadLetterEntry | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(dlDir(ctx), id + '.json'), 'utf8'));
  } catch { return null; }
}

export async function acknowledgeDeadLetter(ctx: TenantContext, id: string): Promise<boolean> {
  try {
    await fsp.unlink(path.join(dlDir(ctx), id + '.json'));
    return true;
  } catch { return false; }
}
