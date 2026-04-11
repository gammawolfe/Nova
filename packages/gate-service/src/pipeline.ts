import crypto from 'crypto';
import fs from 'fs';
import { TenantContext, tenantDataPath } from '@nova/shared/src/tenant';
import { GateErrorCode, NovaError } from '@nova/shared/src/errors';
import { TrustTier, ActorRecord } from '@nova/shared/src/types';
import { auditLog } from '@nova/shared/src/audit';
import { verifyUCAN, extractIssuerDid } from './ucan-verifier';
import { validateSchema } from './schema-validator';
import { extractStrings, patternMatch } from './classifier';
import { writeQuarantine } from './quarantine';

export interface GateContext {
  tenantCtx: TenantContext;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  senderIp?: string;
  requestId?: string;
  agentDid?: string; // Nova's own DID — used for UCAN audience check
}

export interface GateResult {
  passed: boolean;
  decision: 'accepted' | 'quarantined' | 'dropped';
  errorCode?: GateErrorCode | undefined;
  reason?: string | undefined;
  quarantineId?: string | undefined;
  ucanJwt?: string | undefined;
  senderDid?: string | undefined;
  trustTier?: TrustTier | undefined;
  parsedTask?: unknown;
}

/**
 * Executes the 5-layer Gate pipeline synchronously.
 * Returns a GateResult describing whether the task was accepted, quarantined, or dropped.
 */
export async function executeGatePipeline(ctx: GateContext): Promise<GateResult> {
  const { tenantCtx } = ctx;
  const receivedAt = new Date().toISOString();

  // --- STEP 1: UCAN Pre-Extraction ---
  const authHeader = ctx.headers['authorization'];
  let ucanJwt: string | null = null;

  if (authHeader && typeof authHeader === 'string') {
    const match = authHeader.match(/^UCAN\s+(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/);
    if (match?.[1]) {
      ucanJwt = match[1];
    }
  }

  // Extract DID from UCAN for trust tier lookup (without full verification yet)
  let senderDid: string | null = null;
  if (ucanJwt) {
    senderDid = extractIssuerDid(ucanJwt);
  }

  // --- STEP 2: Trust Tier Resolution ---
  const { tier, actorRecord } = resolveTrustTier(tenantCtx, senderDid);

  if (tier === 0) {
    await auditLog(tenantCtx, {
      event: 'actor_unknown',
      senderDid: senderDid ?? undefined,
      tier: 0,
      reason: 'No trust record found for sender DID',
    });

    const qId = writeQuarantine(tenantCtx, {
      receivedAt,
      senderDid,
      rawTask: ctx.body,
      gateStep: 'tier',
      reason: 'actor_unknown',
    });

    if (!qId) {
      await auditLog(tenantCtx, { event: 'quarantine_full' });
    } else {
      await auditLog(tenantCtx, { event: 'task_quarantined', senderDid: senderDid ?? undefined, reason: 'actor_unknown' });
    }

    return {
      passed: false,
      decision: 'quarantined',
      errorCode: 'ACTOR_UNKNOWN',
      reason: `Unknown actor: ${senderDid ?? '(no DID)'}`,
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: 0,
    };
  }

  await auditLog(tenantCtx, {
    event: 'actor_resolved',
    senderDid: senderDid ?? undefined,
    tier,
  });

  // --- STEP 3: UCAN Verification (tier >= 1 only) ---
  if (!ucanJwt) {
    // Missing UCAN → quarantine (not drop — operator may want to review)
    await auditLog(tenantCtx, {
      event: 'ucan_failed',
      senderDid: senderDid ?? undefined,
      tier,
      reason: 'ucan_missing',
    });

    const qId = writeQuarantine(tenantCtx, {
      receivedAt,
      senderDid,
      rawTask: ctx.body,
      gateStep: 'ucan',
      reason: 'ucan_missing',
    });

    return {
      passed: false,
      decision: 'quarantined',
      errorCode: 'UCAN_MISSING',
      reason: 'Missing Authorization: UCAN {jwt} header',
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: tier,
    };
  }

  const agentDid = ctx.agentDid ?? loadAgentDid(tenantCtx);
  const ucanResult = await verifyUCAN(ucanJwt, actorRecord!, agentDid, tenantCtx);

  if (!ucanResult.valid) {
    await auditLog(tenantCtx, {
      event: 'ucan_failed',
      senderDid: senderDid ?? undefined,
      tier,
      reason: ucanResult.reason,
    });

    const qId = writeQuarantine(tenantCtx, {
      receivedAt,
      senderDid,
      rawTask: ctx.body,
      gateStep: 'ucan',
      reason: ucanResult.reason ?? 'ucan_invalid',
    });

    const errorMap: Record<string, GateErrorCode> = {
      ucan_expired: 'UCAN_EXPIRED',
      ucan_revoked: 'UCAN_REVOKED',
      ucan_did_mismatch: 'UCAN_DID_MISMATCH',
      ucan_wrong_audience: 'UCAN_WRONG_AUDIENCE',
      ucan_insufficient_capability: 'UCAN_INSUFFICIENT_CAPABILITY',
      ucan_invalid_jwt: 'UCAN_INVALID_JWT',
    };

    return {
      passed: false,
      decision: 'quarantined',
      errorCode: errorMap[ucanResult.reason ?? ''] ?? 'UCAN_INVALID_JWT',
      reason: ucanResult.reason,
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: tier,
    };
  }

  await auditLog(tenantCtx, {
    event: 'ucan_verified',
    senderDid: senderDid ?? undefined,
    tier,
  });

  // --- STEP 4: Schema Validation ---
  const schemaResult = validateSchema(ctx.body, tenantCtx);

  if (!schemaResult.valid) {
    await auditLog(tenantCtx, {
      event: 'schema_invalid',
      senderDid: senderDid ?? undefined,
      tier,
      reason: schemaResult.reason,
    });

    // Schema failures → DROP (not quarantine) — sender bug
    return {
      passed: false,
      decision: 'dropped',
      errorCode: schemaResult.reason?.startsWith('intent_unknown')
        ? 'INTENT_UNKNOWN'
        : schemaResult.reason?.includes('ttl')
          ? 'TASK_TTL_EXPIRED_AT_INGRESS'
          : 'SCHEMA_INVALID',
      reason: schemaResult.reason,
      senderDid: senderDid ?? undefined,
      trustTier: tier,
    };
  }

  await auditLog(tenantCtx, {
    event: 'schema_valid',
    senderDid: senderDid ?? undefined,
    tier,
  });

  // --- STEP 5: Injection Classification (Stage A — pattern matching) ---
  const params = (schemaResult.parsedTask as any)?.params ?? {};
  const strings = extractStrings(params);
  const patternResult = patternMatch(strings);

  if (patternResult.matched) {
    await auditLog(tenantCtx, {
      event: 'injection_pattern_match',
      senderDid: senderDid ?? undefined,
      tier,
      reason: patternResult.pattern,
      metadata: { path: patternResult.path },
    });

    const qId = writeQuarantine(tenantCtx, {
      receivedAt,
      senderDid,
      rawTask: ctx.body,
      gateStep: 'classifier',
      reason: `injection_pattern_match:${patternResult.pattern}`,
    });

    return {
      passed: false,
      decision: 'quarantined',
      errorCode: 'INJECTION_PATTERN_MATCH',
      reason: `Injection pattern matched at ${patternResult.path}`,
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: tier,
    };
  }

  await auditLog(tenantCtx, {
    event: 'injection_clear',
    senderDid: senderDid ?? undefined,
    tier,
  });

  // All five layers passed
  return {
    passed: true,
    decision: 'accepted',
    ucanJwt,
    senderDid: senderDid ?? undefined,
    trustTier: tier,
    parsedTask: schemaResult.parsedTask,
  };
}

// --- Trust Tier Resolution ---

const DID_SAFE_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._-]+$/;

interface TierResolutionResult {
  tier: TrustTier;
  actorRecord: ActorRecord | null;
}

function resolveTrustTier(tenantCtx: TenantContext, did: string | null): TierResolutionResult {
  if (!did || !DID_SAFE_PATTERN.test(did)) {
    return { tier: 0, actorRecord: null };
  }

  // Spec: filename = sha256hex(did) + '.json'
  const sha256Did = crypto.createHash('sha256').update(did).digest('hex');
  const recordPath = tenantDataPath(tenantCtx, 'trust-registry', sha256Did + '.json');

  if (!fs.existsSync(recordPath)) {
    return { tier: 0, actorRecord: null };
  }

  try {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as ActorRecord;
    return { tier: record.tier as TrustTier, actorRecord: record };
  } catch {
    return { tier: 0, actorRecord: null };
  }
}

/** Read the agent's own DID from the data directory. */
function loadAgentDid(ctx: TenantContext): string {
  const dataRoot = process.env.DATA_ROOT ?? (() => {
    const { resolve, join } = require('path');
    return resolve(process.cwd(), '../../data');
  })();
  const didPath = require('path').join(dataRoot, 'keys', 'nova.did');
  try {
    return fs.readFileSync(didPath, 'utf8').trim();
  } catch {
    return 'did:key:unknown';
  }
}
