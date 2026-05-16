import fsp from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { DATA_ROOT } from './tenant';
import { writeAtomicallyAsync } from './fs-utils';

export const DEFAULT_CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL;

export const ClassifierModeSchema = z.enum(['pattern_ai', 'pattern_only']);

export const ClassifierConfigUpdateSchema = z.object({
  mode: ClassifierModeSchema.optional(),
  provider: z.literal('anthropic').optional(),
  model: z.string().trim().min(1).max(120).optional(),
  apiKey: z.string().trim().min(1).max(500).optional(),
  clearApiKey: z.boolean().optional(),
  failClosed: z.boolean().optional(),
}).refine((v) => !(v.apiKey && v.clearApiKey), {
  message: 'apiKey and clearApiKey cannot both be set',
  path: ['apiKey'],
});

export type ClassifierMode = z.infer<typeof ClassifierModeSchema>;
export type ClassifierConfigUpdate = z.infer<typeof ClassifierConfigUpdateSchema>;

export interface StoredClassifierConfig {
  mode: ClassifierMode;
  provider: 'anthropic';
  model: string;
  apiKey?: string;
  failClosed: boolean;
  updatedAt: string;
}

export interface EffectiveClassifierConfig {
  mode: ClassifierMode;
  provider: 'anthropic';
  model: string;
  apiKey?: string;
  apiKeySource: 'env' | 'stored' | 'none';
  failClosed: boolean;
  aiEnabled: boolean;
  storedKeyConfigured: boolean;
  envKeyConfigured: boolean;
}

const StoredClassifierConfigSchema = z.object({
  mode: ClassifierModeSchema.default('pattern_ai'),
  provider: z.literal('anthropic').default('anthropic'),
  model: z.string().trim().min(1).default(DEFAULT_CLASSIFIER_MODEL),
  apiKey: z.string().trim().min(1).optional(),
  failClosed: z.boolean().default(true),
  updatedAt: z.string().datetime().default(() => new Date().toISOString()),
});

function configPath(): string {
  return path.join(DATA_ROOT, 'config', 'classifier.json');
}

function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function parseModeEnv(raw: string | undefined): ClassifierMode | undefined {
  if (raw === 'pattern_ai' || raw === 'pattern_only') return raw;
  return undefined;
}

export async function loadStoredClassifierConfig(): Promise<StoredClassifierConfig | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(configPath(), 'utf8'));
    const parsed = StoredClassifierConfigSchema.parse(raw);
    return {
      mode: parsed.mode,
      provider: parsed.provider,
      model: parsed.model,
      failClosed: parsed.failClosed,
      updatedAt: parsed.updatedAt,
      ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
    };
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveClassifierConfigUpdate(update: ClassifierConfigUpdate): Promise<StoredClassifierConfig> {
  const current = await loadStoredClassifierConfig();
  const next: StoredClassifierConfig = {
    mode: update.mode ?? current?.mode ?? 'pattern_ai',
    provider: 'anthropic',
    model: update.model ?? current?.model ?? DEFAULT_CLASSIFIER_MODEL,
    failClosed: update.failClosed ?? current?.failClosed ?? true,
    updatedAt: new Date().toISOString(),
    ...(current?.apiKey && !update.clearApiKey ? { apiKey: current.apiKey } : {}),
  };
  if (update.apiKey) next.apiKey = update.apiKey;
  const finalPath = configPath();
  await writeAtomicallyAsync(finalPath, next);
  await fsp.chmod(finalPath, 0o600);
  return next;
}

export async function loadEffectiveClassifierConfig(env: NodeJS.ProcessEnv = process.env): Promise<EffectiveClassifierConfig> {
  const stored = await loadStoredClassifierConfig();
  const envKey = env.ANTHROPIC_API_KEY?.trim();
  const storedKey = stored?.apiKey?.trim();
  const apiKey = envKey || storedKey || undefined;
  const mode = parseModeEnv(env.GATE_LLM_CLASSIFIER_MODE) ?? stored?.mode ?? 'pattern_ai';
  const model = env.CLASSIFIER_MODEL?.trim() || stored?.model || DEFAULT_CLASSIFIER_MODEL;
  const failClosed = parseBooleanEnv(env.GATE_LLM_FAIL_CLOSED) ?? stored?.failClosed ?? true;

  return {
    mode,
    provider: 'anthropic',
    model,
    ...(apiKey ? { apiKey } : {}),
    apiKeySource: envKey ? 'env' : storedKey ? 'stored' : 'none',
    failClosed,
    aiEnabled: mode === 'pattern_ai' && !!apiKey,
    storedKeyConfigured: !!storedKey,
    envKeyConfigured: !!envKey,
  };
}

export function publicClassifierConfig(config: EffectiveClassifierConfig, stored: StoredClassifierConfig | null) {
  return {
    mode: config.mode,
    provider: config.provider,
    model: config.model,
    failClosed: config.failClosed,
    aiEnabled: config.aiEnabled,
    apiKeySource: config.apiKeySource,
    envKeyConfigured: config.envKeyConfigured,
    storedKeyConfigured: config.storedKeyConfigured,
    updatedAt: stored?.updatedAt ?? null,
  };
}
