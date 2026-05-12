import fs from 'fs';
import path from 'path';

/**
 * Interface defining a tenant organization within Nova.
 */
export interface Tenant {
  id: string; // UUID, assigned by Nova on registration
  name: string; // Human-readable name
  slug: string; // URL-safe identifier — used in paths and namespacing
  createdAt: string; // ISO 8601
  status: 'active' | 'suspended' | 'deleted';
  plan: 'developer' | 'pro' | 'enterprise';
  quotas: TenantQuotas;
}

export interface TenantQuotas {
  messagesPerDay: number; // -1 for unlimited
  agentsMax: number;
  trustedSendersMax: number;
}

/**
 * Context defining an isolated workload scope for a specific agent belonging to a specific tenant.
 */
export interface TenantContext {
  tenantId: string;
  agentId: string;
}

/**
 * Centralized utility to ensure all Redis keys are securely namespaced per isolate.
 */
export function redisKey(ctx: TenantContext, ...parts: string[]): string {
  return `t:${ctx.tenantId}:a:${ctx.agentId}:${parts.join(':')}`;
}

// ── DATA_ROOT resolution ────────────────────────────────────────────────────
//
// Precedence:
//   1. `DATA_ROOT` env var          — production deployments set this
//      explicitly. Always honoured first.
//   2. Workspace-root walk-up       — when running anywhere inside the Nova
//      monorepo (dev, tests, scripts, compiled `dist/` under
//      `packages/*/`), walk up from this module's own location looking for
//      a `package.json` declaring `workspaces`. The first such directory is
//      the workspace root and DATA_ROOT defaults to `<root>/data`.
//   3. process.cwd() fallback       — last resort, with a stderr warning.
//      Matches the prior behaviour so existing setups don't break, but the
//      warning surfaces misconfigured deployments instead of silently
//      computing a wrong path.
//
// The previous default `path.resolve(process.cwd(), '../../data')` only
// produced a correct path when CWD was a `packages/*/` directory. Tests,
// CLI invocations, and scripts running from elsewhere computed paths
// pointing outside the project; the `vi.hoisted` test setup in
// gate-service papered over this.

interface ResolveDataRootOptions {
  startDir: string;
  env: NodeJS.ProcessEnv;
  /** Override the warning sink (used by tests). */
  warn?: (msg: string) => void;
}

export function resolveDataRoot(opts: ResolveDataRootOptions): string {
  const envValue = opts.env.DATA_ROOT;
  if (envValue) return envValue;

  const workspaceRoot = findWorkspaceRoot(opts.startDir);
  if (workspaceRoot) return path.join(workspaceRoot, 'data');

  const fallback = path.resolve(process.cwd(), '../../data');
  const warn = opts.warn ?? ((msg) => process.stderr.write(msg + '\n'));
  warn(
    `[nova/shared] DATA_ROOT env var not set and no npm workspace root found ` +
    `from ${opts.startDir}; falling back to ${fallback}. Set DATA_ROOT explicitly ` +
    `to silence this warning.`,
  );
  return fallback;
}

/**
 * Walk up from `startDir` looking for a `package.json` whose top-level
 * declares a `workspaces` field. Returns the directory containing that
 * file, or null if no such ancestor exists. Synchronous because this runs
 * exactly once at module load — async would force every importer to await
 * something they don't care about.
 *
 * Stops at the filesystem root to avoid infinite-looping on broken FS
 * states or chroot-style environments.
 */
function findWorkspaceRoot(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const pkgPath = path.join(current, 'package.json');
    try {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      if (pkg && pkg.workspaces !== undefined) return current;
    } catch {
      // No package.json here, or unparseable — keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return null; // reached FS root
    current = parent;
  }
}

export const DATA_ROOT: string = resolveDataRoot({
  startDir: __dirname,
  env: process.env,
});

export const KEY_ROOT: string = process.env.NOVA_KEY_DIR || path.join(DATA_ROOT, 'keys');

/**
 * Centralized utility to ensure all file-system paths are securely directed per isolate.
 */
export function tenantDataPath(ctx: TenantContext, ...parts: string[]): string {
  return path.join(
    DATA_ROOT,
    'tenants',
    ctx.tenantId,
    'agents',
    ctx.agentId,
    ...parts
  );
}

/**
 * Generates the standardized BullMQ queue name for a specific TrustTier per isolate.
 */
export function queueName(ctx: TenantContext, tier: number): string {
  return `nova:t:${ctx.tenantId}:a:${ctx.agentId}:tasks:tier${tier}`;
}
