import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { TenantContext, tenantDataPath, KEY_ROOT } from '@nova/shared/src/tenant';
import { GateErrorCode, NovaError } from '@nova/shared/src/errors';
import { TrustTier, ActorRecord } from '@nova/shared/src/types';
import { auditLog } from '@nova/shared/src/audit';
import { logger } from '@nova/shared/src/logger';
import { verifyUCAN, extractIssuerDid } from './ucan-verifier';
import { validateSchema } from './schema-validator';
import { extractStrings, patternMatch, llmClassify, classifyDecision } from './classifier';
import { writeQuarantine } from './quarantine';
import { gateDecisions, gateLatency, classifierResults, quarantineDepth } from './metrics';

const GATE_LLM_FAIL_CLOSED = process.env.GATE_LLM_FAIL_CLOSED === 'true';

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
  const endTimer = gateLatency.startTimer();

  async function recordAndReturn(result: GateResult): Promise<GateResult> {
    endTimer();
    gateDecisions.inc({ decision: result.decision, error_code: result.errorCode ?? 'none' });
    if (result.decision === 'quarantined') {
      try {
        const qDir = tenantDataPath(tenantCtx, 'quarantine');
        const count = (await fsp.readdir(qDir)).filter(f => f.endsWith('.json')).length;
        quarantineDepth.set({ tenant_id: tenantCtx.tenantId, agent_id: tenantCtx.agentId }, count);
      } catch { /* dir may not exist */ }
    }
    return result;
  }

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
  const { tier, actorRecord } = await resolveTrustTier(tenantCtx, senderDid);

  if (tier === 0) {
    await auditLog(tenantCtx, {
      event: 'actor_unknown',
      senderDid: senderDid ?? undefined,
      tier: 0,
      reason: 'No trust record found for sender DID',
    });

    const qId = await writeQuarantine(tenantCtx, {
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

    return await recordAndReturn({
      passed: false,
      decision: 'quarantined',
      errorCode: 'ACTOR_UNKNOWN',
      reason: `Unknown actor: ${senderDid ?? '(no DID)'}`,
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: 0,
    });
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

    const qId = await writeQuarantine(tenantCtx, {
      receivedAt,
      senderDid,
      rawTask: ctx.body,
      gateStep: 'ucan',
      reason: 'ucan_missing',
    });

    return await recordAndReturn({
      passed: false,
      decision: 'quarantined',
      errorCode: 'UCAN_MISSING',
      reason: 'Missing Authorization: UCAN {jwt} header',
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: tier,
    });
  }

  const agentDid = ctx.agentDid ?? await loadAgentDid();
  const ucanResult = await verifyUCAN(ucanJwt, actorRecord!, agentDid, tenantCtx);

  if (!ucanResult.valid) {
    await auditLog(tenantCtx, {
      event: 'ucan_failed',
      senderDid: senderDid ?? undefined,
      tier,
      reason: ucanResult.reason,
    });

    const qId = await writeQuarantine(tenantCtx, {
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

    return await recordAndReturn({
      passed: false,
      decision: 'quarantined',
      errorCode: errorMap[ucanResult.reason ?? ''] ?? 'UCAN_INVALID_JWT',
      reason: ucanResult.reason,
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: tier,
    });
  }

  await auditLog(tenantCtx, {
    event: 'ucan_verified',
    senderDid: senderDid ?? undefined,
    tier,
  });

  // --- STEP 4: Schema Validation ---
  const schemaResult = await validateSchema(ctx.body, tenantCtx);

  if (!schemaResult.valid) {
    await auditLog(tenantCtx, {
      event: 'schema_invalid',
      senderDid: senderDid ?? undefined,
      tier,
      reason: schemaResult.reason,
    });

    // Schema failures → DROP (not quarantine) — sender bug
    return await recordAndReturn({
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
    });
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

    const qId = await writeQuarantine(tenantCtx, {
      receivedAt,
      senderDid,
      rawTask: ctx.body,
      gateStep: 'classifier',
      reason: `injection_pattern_match:${patternResult.pattern}`,
    });

    classifierResults.inc({ result: 'quarantine', stage: 'pattern' });
    return await recordAndReturn({
      passed: false,
      decision: 'quarantined',
      errorCode: 'INJECTION_PATTERN_MATCH',
      reason: `Injection pattern matched at ${patternResult.path}`,
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: tier,
    });
  }

  classifierResults.inc({ result: 'pass', stage: 'pattern' });
  await auditLog(tenantCtx, {
    event: 'injection_pattern_clear',
    senderDid: senderDid ?? undefined,
    tier,
  });

  // --- STEP 5B: LLM Classification ---
  try {
    const llmResult = await llmClassify(strings, tenantCtx);
    const decision = classifyDecision(llmResult);

    if (decision === 'quarantine') {
      const confidenceHigh = llmResult.confidence >= 0.85;
      const reason = confidenceHigh
        ? `injection_detected:confidence=${llmResult.confidence}`
        : `injection_suspected:confidence=${llmResult.confidence}`;
      const errorCode: GateErrorCode = confidenceHigh
        ? 'INJECTION_DETECTED'
        : 'INJECTION_SUSPECTED';

      await auditLog(tenantCtx, {
        event: confidenceHigh ? 'injection_detected' : 'injection_suspected',
        senderDid: senderDid ?? undefined,
        tier,
        reason,
        metadata: { indicators: llmResult.indicators },
      });

      const qId = await writeQuarantine(tenantCtx, {
        receivedAt,
        senderDid,
        rawTask: ctx.body,
        gateStep: 'classifier',
        reason,
      });

      classifierResults.inc({ result: 'quarantine', stage: 'llm' });
      return await recordAndReturn({
        passed: false,
        decision: 'quarantined',
        errorCode,
        reason: `LLM classifier flagged injection (${llmResult.confidence})`,
        quarantineId: qId ?? undefined,
        senderDid: senderDid ?? undefined,
        trustTier: tier,
      });
    }

    classifierResults.inc({ result: 'pass', stage: 'llm' });
    await auditLog(tenantCtx, {
      event: 'injection_clear',
      senderDid: senderDid ?? undefined,
      tier,
      metadata: { classifierConfidence: llmResult.confidence, fromCache: llmResult.fromCache },
    });
  } catch (err: any) {
    if (GATE_LLM_FAIL_CLOSED) {
      await auditLog(tenantCtx, {
        event: 'classifier_unavailable',
        senderDid: senderDid ?? undefined,
        tier,
        reason: err.message,
      });
      const qId = await writeQuarantine(tenantCtx, {
        receivedAt,
        senderDid,
        rawTask: ctx.body,
        gateStep: 'classifier',
        reason: `classifier_unavailable:${err.message}`,
      });
      classifierResults.inc({ result: 'quarantine', stage: 'llm_error' });
      return await recordAndReturn({
        passed: false,
        decision: 'quarantined',
        errorCode: 'CLASSIFIER_UNAVAILABLE',
        reason: `LLM classifier unavailable: ${err.message}`,
        quarantineId: qId ?? undefined,
        senderDid: senderDid ?? undefined,
        trustTier: tier,
      });
    }

    // Classifier unavailable → skip the LLM check, let the request through.
    // The other 5 gates (actor, UCAN, audit, schema, pattern) still protect us.
    await auditLog(tenantCtx, {
      event: 'classifier_unavailable',
      senderDid: senderDid ?? undefined,
      tier,
      reason: err.message,
    });
    logger.warn(
      { err: err.message },
      'LLM classifier unavailable — skipping injection check, relying on other gates'
    );
  }

  // All five layers passed
  return await recordAndReturn({
    passed: true,
    decision: 'accepted',
    ucanJwt,
    senderDid: senderDid ?? undefined,
    trustTier: tier,
    parsedTask: schemaResult.parsedTask,
  });
}

// --- Trust Tier Resolution ---

const DID_SAFE_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._-]+$/;

interface TierResolutionResult {
  tier: TrustTier;
  actorRecord: ActorRecord | null;
}

function didHash(did: string): string {
  return crypto.createHash('sha256').update(did).digest('hex');
}

async function resolveTrustTier(tenantCtx: TenantContext, did: string | null): Promise<TierResolutionResult> {
  if (!did || !DID_SAFE_PATTERN.test(did)) {
    return { tier: 0, actorRecord: null };
  }

  const recordPath = tenantDataPath(tenantCtx, 'trust-registry', didHash(did) + '.json');

  try {
    const record = JSON.parse(await fsp.readFile(recordPath, 'utf8')) as ActorRecord;
    return { tier: record.tier as TrustTier, actorRecord: record };
  } catch {
    return { tier: 0, actorRecord: null };
  }
}

/** Read the agent's own DID from the data directory. Cached after first read. */
let _cachedAgentDid: string | null = null;

async function loadAgentDid(): Promise<string> {
  if (_cachedAgentDid) return _cachedAgentDid;
  const didPath = path.join(KEY_ROOT, 'nova.did');
  try {
    _cachedAgentDid = (await fsp.readFile(didPath, 'utf8')).trim();
    return _cachedAgentDid;
  } catch (err: any) {
    throw new Error(`Cannot read agent DID from ${didPath}: ${err.message}`);
  }
}
