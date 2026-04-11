import { TrustTier } from './types';

export interface ConfirmRequest {
  id: string;
  taskId: string;
  intent: string;
  params: Record<string, unknown>;
  senderDid: string;
  tier: TrustTier;
  requestedAt: string;
  timeoutAt: string;
  status: 'pending' | 'approved' | 'denied' | 'timeout';
  reviewedBy?: string;
  reviewedAt?: string;
}

const DEFAULT_TIMEOUTS: Record<string, number> = {
  schedule_action: 86400,   // 24h
  spawn_subagent: 14400,    // 4h
  modify_config: 3600,      // 1h
  delete_data: 3600,        // 1h
};

/**
 * Returns the confirmation timeout in seconds for a given intent.
 * Checks per-intent env vars first, then defaults.
 */
export function getConfirmTimeout(intent: string): number {
  const envKey = `CONFIRM_TIMEOUT_${intent.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal) return parseInt(envVal, 10);
  return DEFAULT_TIMEOUTS[intent] ?? 3600;
}
