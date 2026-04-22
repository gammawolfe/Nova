// packages/broker-receiver/src/config.ts
//
// Resolve the daemon's runtime config from three sources, in precedence
// order: CLI flags > environment variables > ~/.nova/broker-receiver.json.
//
// Callers pass the parsed CLI object and any env overrides they want honored;
// the rest is filled from the config file (if present) and hard-coded
// defaults. The output is the authoritative runtime config — all other
// modules treat it as frozen.

import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';

export const DEFAULT_NOVA_URL = 'http://localhost:3001';
export const DEFAULT_POLL_WAIT_MS = 30_000;
export const DEFAULT_MAX_CONCURRENT_TASKS = 1;
export const DEFAULT_SHUTDOWN_GRACE_SECONDS = 30;

// Handler names that ship with the daemon. Adding a new handler means
// extending this enum (and registering it in handlers/index.ts). Rejecting
// unknown handler strings at config parse time catches typos early instead
// of producing a confusing runtime "handler not found" error.
export const HANDLER_NAMES = ['echo', 'claude-api'] as const;
export type HandlerName = (typeof HANDLER_NAMES)[number];

export const ReceiverConfigSchema = z.object({
  agentId: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64),
  novaUrl: z.string().url().default(DEFAULT_NOVA_URL),
  handler: z.enum(HANDLER_NAMES).default('echo'),
  handlerConfig: z.record(z.unknown()).default({}),
  pollWaitMs: z.number().int().min(1_000).max(60_000).default(DEFAULT_POLL_WAIT_MS),
  maxConcurrentTasks: z.number().int().min(1).max(32).default(DEFAULT_MAX_CONCURRENT_TASKS),
  healthPort: z.number().int().min(0).max(65_535).default(0),
  shutdownGraceSeconds: z.number().int().min(1).max(300).default(DEFAULT_SHUTDOWN_GRACE_SECONDS),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type ReceiverConfig = z.infer<typeof ReceiverConfigSchema>;

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.nova', 'broker-receiver.json');

export interface ConfigInputs {
  cli: Partial<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

/**
 * Merge CLI flags, env vars, and the JSON file into a validated config.
 * Throws a ZodError with human-readable issues if required fields are
 * missing. Does not touch the network or filesystem beyond reading the
 * config file.
 */
export async function resolveConfig(inputs: ConfigInputs): Promise<ReceiverConfig> {
  const env = inputs.env ?? process.env;
  const configPath = inputs.configPath ?? env.BROKER_RECEIVER_CONFIG ?? DEFAULT_CONFIG_PATH;

  const fileConfig = await readConfigFile(configPath);

  // Merge order: file < env < cli. Later keys win. Undefined values from
  // earlier tiers leak through, so we explicitly strip them on the way in.
  const envConfig = extractEnvConfig(env);
  const cliConfig = stripUndefined(inputs.cli);

  const merged: Record<string, unknown> = {
    ...fileConfig,
    ...envConfig,
    ...cliConfig,
  };

  return ReceiverConfigSchema.parse(merged);
}

async function readConfigFile(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error(`${configPath} must contain a JSON object`);
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function extractEnvConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (env.NOVA_AGENT_ID) out.agentId = env.NOVA_AGENT_ID;
  if (env.NOVA_URL) out.novaUrl = env.NOVA_URL;
  if (env.BROKER_RECEIVER_HANDLER) out.handler = env.BROKER_RECEIVER_HANDLER;
  if (env.BROKER_RECEIVER_POLL_WAIT_MS) out.pollWaitMs = parseInt(env.BROKER_RECEIVER_POLL_WAIT_MS, 10);
  if (env.BROKER_RECEIVER_MAX_CONCURRENT) out.maxConcurrentTasks = parseInt(env.BROKER_RECEIVER_MAX_CONCURRENT, 10);
  if (env.BROKER_RECEIVER_HEALTH_PORT) out.healthPort = parseInt(env.BROKER_RECEIVER_HEALTH_PORT, 10);
  if (env.BROKER_RECEIVER_SHUTDOWN_GRACE) out.shutdownGraceSeconds = parseInt(env.BROKER_RECEIVER_SHUTDOWN_GRACE, 10);
  if (env.BROKER_RECEIVER_LOG_LEVEL) out.logLevel = env.BROKER_RECEIVER_LOG_LEVEL;
  return out;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as any)[k] = v;
  }
  return out;
}
