import fsp from 'fs/promises';
import path from 'path';
import { TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';
import { ConfirmRequest } from '@nova/shared/src/confirmation';

function confirmDir(ctx: TenantContext): string {
  return tenantDataPath(ctx, 'confirm-queue');
}

export async function listPending(ctx: TenantContext): Promise<ConfirmRequest[]> {
  const dir = confirmDir(ctx);
  let files: string[];
  try { files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json')); }
  catch { return []; }

  const entries = (await Promise.all(
    files.map(async f => {
      try { return JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) as ConfirmRequest; }
      catch { return null; }
    })
  )).filter((e): e is ConfirmRequest => e !== null && e.status === 'pending');

  return entries;
}

export async function getConfirmRequest(ctx: TenantContext, id: string): Promise<ConfirmRequest | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(confirmDir(ctx), id + '.json'), 'utf8'));
  } catch { return null; }
}

export async function approveConfirmRequest(ctx: TenantContext, id: string, reviewedBy = 'admin'): Promise<ConfirmRequest | null> {
  const req = await getConfirmRequest(ctx, id);
  if (!req || req.status !== 'pending') return null;
  req.status = 'approved';
  req.reviewedBy = reviewedBy;
  req.reviewedAt = new Date().toISOString();
  await writeAtomicallyAsync(path.join(confirmDir(ctx), id + '.json'), req);
  return req;
}

export async function denyConfirmRequest(ctx: TenantContext, id: string, reviewedBy = 'admin'): Promise<ConfirmRequest | null> {
  const req = await getConfirmRequest(ctx, id);
  if (!req || req.status !== 'pending') return null;
  req.status = 'denied';
  req.reviewedBy = reviewedBy;
  req.reviewedAt = new Date().toISOString();
  await writeAtomicallyAsync(path.join(confirmDir(ctx), id + '.json'), req);
  return req;
}
