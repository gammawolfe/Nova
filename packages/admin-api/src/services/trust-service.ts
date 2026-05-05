import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { TenantContext, tenantDataPath } from '@nova/shared';
import { writeAtomicallyAsync } from '@nova/shared';
import { ActorRecord } from '@nova/shared';

function didHash(did: string): string {
  return crypto.createHash('sha256').update(did).digest('hex');
}

function registryDir(ctx: TenantContext): string {
  return tenantDataPath(ctx, 'trust-registry');
}

function actorFile(ctx: TenantContext, did: string): string {
  return path.join(registryDir(ctx), didHash(did) + '.json');
}

export async function addActor(ctx: TenantContext, data: {
  did: string; displayName: string; tier: number; allowedSkills: string[]; notes?: string | undefined;
}): Promise<ActorRecord> {
  await fsp.mkdir(registryDir(ctx), { recursive: true });

  const record: ActorRecord = {
    did: data.did,
    displayName: data.displayName,
    tier: data.tier as 0 | 1 | 2 | 3,
    allowedSkills: data.allowedSkills,
    addedAt: new Date().toISOString(),
    addedBy: 'admin',
    notes: data.notes,
  };

  await writeAtomicallyAsync(actorFile(ctx, data.did), record);
  return record;
}

export async function listActors(ctx: TenantContext): Promise<ActorRecord[]> {
  const dir = registryDir(ctx);
  let files: string[];
  try { files = await fsp.readdir(dir); }
  catch { return []; }

  const records = await Promise.all(
    files
      .filter(f => f.endsWith('.json'))
      .map(async f => {
        try {
          return JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) as ActorRecord;
        } catch { return null; }
      })
  );
  return records.filter((r): r is ActorRecord => r !== null);
}

export async function getActor(ctx: TenantContext, did: string): Promise<ActorRecord | null> {
  try {
    return JSON.parse(await fsp.readFile(actorFile(ctx, did), 'utf8'));
  } catch { return null; }
}

export async function updateActorTier(ctx: TenantContext, did: string, tier: number): Promise<ActorRecord | null> {
  const record = await getActor(ctx, did);
  if (!record) return null;
  record.tier = tier as 0 | 1 | 2 | 3;
  await writeAtomicallyAsync(actorFile(ctx, did), record);
  return record;
}

export async function removeActor(ctx: TenantContext, did: string): Promise<boolean> {
  try {
    await fsp.unlink(actorFile(ctx, did));
    return true;
  } catch { return false; }
}
