import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { DATA_ROOT } from '@nova/shared/src/tenant';
import { writeAtomicallyAsync } from '@nova/shared/src/fs-utils';
import { Tenant, TenantQuotas } from '@nova/shared/src/tenant';
import { ID_RE, validateId } from '@nova/shared/src/validation';

const tenantsDir = path.join(DATA_ROOT, 'tenants');

function tenantFile(tenantId: string): string {
  validateId(tenantId, 'tenantId');
  return path.join(tenantsDir, tenantId, 'tenant.json');
}

export async function createTenant(data: {
  name: string; slug: string;
  plan?: Tenant['plan'] | undefined; quotas?: Partial<TenantQuotas> | undefined;
}): Promise<Tenant> {
  const id = `tenant_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const tenant: Tenant = {
    id,
    name: data.name,
    slug: data.slug,
    createdAt: new Date().toISOString(),
    status: 'active',
    plan: data.plan ?? 'developer',
    quotas: {
      messagesPerDay: data.quotas?.messagesPerDay ?? 1000,
      agentsMax: data.quotas?.agentsMax ?? 5,
      trustedSendersMax: data.quotas?.trustedSendersMax ?? 50,
    },
  };

  await fsp.mkdir(path.join(tenantsDir, id), { recursive: true });
  await writeAtomicallyAsync(tenantFile(id), tenant);
  return tenant;
}

export async function listTenants(): Promise<Tenant[]> {
  let dirs: string[];
  try { dirs = await fsp.readdir(tenantsDir); }
  catch { return []; }

  const tenants = await Promise.all(
    dirs
      .filter(d => ID_RE.test(d))
      .map(async d => {
        try {
          const raw = await fsp.readFile(path.join(tenantsDir, d, 'tenant.json'), 'utf8');
          return JSON.parse(raw) as Tenant;
        } catch { return null; }
      })
  );
  return tenants.filter((t): t is Tenant => t !== null && t.status !== 'deleted');
}

export async function getTenant(tenantId: string): Promise<Tenant | null> {
  try {
    return JSON.parse(await fsp.readFile(tenantFile(tenantId), 'utf8'));
  } catch { return null; }
}

export async function updateTenant(
  tenantId: string,
  updates: {
    name?: string | undefined;
    status?: Tenant['status'] | undefined;
    plan?: Tenant['plan'] | undefined;
    quotas?: Partial<TenantQuotas> | undefined;
  }
): Promise<Tenant | null> {
  const tenant = await getTenant(tenantId);
  if (!tenant) return null;
  const updated: Tenant = {
    ...tenant,
    ...(updates.name !== undefined && { name: updates.name }),
    ...(updates.status !== undefined && { status: updates.status }),
    ...(updates.plan !== undefined && { plan: updates.plan }),
  };
  if (updates.quotas) {
    updated.quotas = {
      ...tenant.quotas,
      ...(updates.quotas.messagesPerDay !== undefined && { messagesPerDay: updates.quotas.messagesPerDay }),
      ...(updates.quotas.agentsMax !== undefined && { agentsMax: updates.quotas.agentsMax }),
      ...(updates.quotas.trustedSendersMax !== undefined && { trustedSendersMax: updates.quotas.trustedSendersMax }),
    };
  }
  await writeAtomicallyAsync(tenantFile(tenantId), updated);
  return updated;
}

export async function deleteTenant(tenantId: string): Promise<boolean> {
  const tenant = await getTenant(tenantId);
  if (!tenant) return false;
  tenant.status = 'deleted';
  await writeAtomicallyAsync(tenantFile(tenantId), tenant);
  return true;
}
