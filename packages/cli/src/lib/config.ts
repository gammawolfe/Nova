// packages/cli/src/lib/config.ts
//
// Resolves the operator CLI config from three sources in precedence order:
//   CLI flags > environment variables > ~/.nova/cli.json
//
// Written on first `nova setup` and read by every subsequent command.

import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

export const CONFIG_PATH = path.join(os.homedir(), '.nova', 'cli.json');

export interface CliConfig {
  novaUrl: string;        // a2a-server base URL
  adminUrl: string;       // admin-api base URL
  adminToken: string;     // Bearer token for admin endpoints
}

export type PartialCliConfig = Partial<CliConfig>;

export async function readConfig(): Promise<PartialCliConfig> {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PartialCliConfig;
    }
    return {};
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeConfig(config: PartialCliConfig): Promise<void> {
  const dir = path.dirname(CONFIG_PATH);
  await fsp.mkdir(dir, { recursive: true });
  const existing = await readConfig();
  const merged = { ...existing, ...config };
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Resolve full config from file + env + CLI flag overrides.
 * Returns null fields as undefined — callers that need a specific field
 * should call requireConfig().
 */
export async function resolveConfig(overrides: PartialCliConfig = {}): Promise<PartialCliConfig> {
  const file = await readConfig();
  const env: PartialCliConfig = {
    novaUrl: process.env.NOVA_URL,
    adminUrl: process.env.NOVA_ADMIN_URL,
    adminToken: process.env.NOVA_ADMIN_TOKEN,
  };
  // Strip undefined env values
  Object.keys(env).forEach(k => {
    if ((env as any)[k] === undefined) delete (env as any)[k];
  });
  return { ...file, ...env, ...overrides };
}

/**
 * Like resolveConfig but throws a human-readable error if any required
 * field is missing. Call this at the start of commands that hit the API.
 */
export async function requireConfig(overrides: PartialCliConfig = {}): Promise<CliConfig> {
  const c = await resolveConfig(overrides);
  const missing: string[] = [];
  if (!c.novaUrl) missing.push('novaUrl (set NOVA_URL or run nova setup)');
  if (!c.adminUrl) missing.push('adminUrl (set NOVA_ADMIN_URL or run nova setup)');
  if (!c.adminToken) missing.push('adminToken (set NOVA_ADMIN_TOKEN or run nova setup)');
  if (missing.length) {
    throw new CliError(`Missing config:\n${missing.map(m => `  • ${m}`).join('\n')}`);
  }
  return c as CliConfig;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
