import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { TenantContext, tenantDataPath, KEY_ROOT } from '@nova/shared/src/tenant';
import { GateErrorCode, NovaError } from '@nova/shared/src/errors';
import { TrustTier, ActorRecord } from '@nova/shared/src/types';
import { auditLog } from '@nova/shared/src/audit';
import { logger } from '@nova/shared/src/logger';
import { getSharedRedis } from '@nova/shared/src/redis';
import { getAgentByDid } from '@nova/shared/src/agent-index';
import { verifyUCAN, extractIssuerDid } from './ucan-verifier';
import { validateSchema } from './schema-validator';
import { extractStrings, patternMatch, llmClassify, classifyDecision } from './classifier';
import { writeQuarantine } from './quarantine';
import { gateDecisions, gateLatency, classifierResults } from './metrics';

// Default fail-closed: when the LLM classifier is unavailable, quarantine
// the request rather than let it through. Operators can opt in to fail-open
// by setting GATE_LLM_FAIL_CLOSED=false, but this leaves layer-5 injection
// detection offline during outages.
const GATE_LLM_FAIL_CLOSED = process.env.GATE_LLM_FAIL_CLOSED !== 'false';

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
    // Note: prior versions did a fsp.readdir on the quarantine directory
    // here to update the quarantineDepth gauge. That readdir ran on every
    // quarantine decision and scaled with the directory's size — under
    // quarantine pressure (DDoS, broken sender) it could dominate the
    // gate hot path. Removed in favour of the `nova_gate_decisions_total
    // {decision="quarantined"}` counter, which gives operators the same
    // information without disk I/O. Periodic depth-sampling (background
    // sweep) can be added back later if absolute pending-depth becomes a
    // first-class signal again.
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
  // In the sender-signed delegation model the gate is the audience on every
  // invocation (aud = novaDid). The invocation's att must express a capability
  // for this specific destination agent — we allow any sub-scope under
  // `nova:<tenantId>:<agentId>:skill:*` (skill granularity is enforced later
  // in schema validation against the destination's registered skill list).
  const requiredScope = `nova:${tenantCtx.tenantId}:${tenantCtx.agentId}:skill:*`;
  const ucanResult = await verifyUCAN(ucanJwt, tenantCtx, agentDid, requiredScope);

  if (!ucanResult.valid) {
    // chain-walking failures surface a depth (where in the chain we
    // stopped) and sometimes a partial chainLength — attach both to
    // metadata so operators can distinguish a failed single-link grant
    // (chainDepth 1) from a failure deep in a federation chain. The
    // existing `reason` string still drives alerting; metadata is for
    // diagnostics.
    const failureMetadata: Record<string, unknown> = {};
    if (ucanResult.chainDepth !== undefined) failureMetadata.chainDepth = ucanResult.chainDepth;
    await auditLog(tenantCtx, {
      event: 'ucan_failed',
      senderDid: senderDid ?? undefined,
      tier,
      reason: ucanResult.reason,
      ...(Object.keys(failureMetadata).length > 0 ? { metadata: failureMetadata } : {}),
    });

    const qId = await writeQuarantine(tenantCtx, {
      receivedAt,
      senderDid,
      rawTask: ctx.body,
      gateStep: 'ucan',
      reason: ucanResult.reason ?? 'ucan_invalid',
    });

    return await recordAndReturn({
      passed: false,
      decision: 'quarantined',
      errorCode: mapReasonToGateErrorCode(ucanResult.reason),
      reason: ucanResult.reason,
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: tier,
    });
  }

  // Federation context: chainLength=2 is a today-style single-link grant
  // (outer + Nova-signed root). chainLength >= 3 means the invocation came
  // through a peer Nova — peerDid identifies which. Surfacing both in
  // audit metadata lets operators filter and attribute federated traffic
  // distinctly from local traffic without introducing a new event type.
  const verifyMetadata: Record<string, unknown> = {};
  if (ucanResult.chainLength !== undefined) verifyMetadata.chainLength = ucanResult.chainLength;
  if (ucanResult.peerDid !== undefined) verifyMetadata.peerDid = ucanResult.peerDid;
  await auditLog(tenantCtx, {
    event: 'ucan_verified',
    senderDid: senderDid ?? undefined,
    tier,
    ...(Object.keys(verifyMetadata).length > 0 ? { metadata: verifyMetadata } : {}),
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

    // Classifier unavailable + GATE_LLM_FAIL_CLOSED=false → fail-open:
    // skip layer-5 LLM injection detection and let the request through.
    // Layers 1-4 (tier, UCAN, schema, pattern-match) still run.
    await auditLog(tenantCtx, {
      event: 'classifier_unavailable',
      senderDid: senderDid ?? undefined,
      tier,
      reason: err.message,
      metadata: { failMode: 'open' },
    });
    classifierResults.inc({ result: 'fail_open', stage: 'llm_error' });
    logger.warn(
      { err: err.message },
      'LLM classifier unavailable — fail-open enabled (GATE_LLM_FAIL_CLOSED=false), injection detection bypassed'
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

/**
 * Hash a DID for use as a trust-registry filename. We hash rather than
 * use the DID directly so a `readdir` of the trust-registry directory
 * doesn't leak the set of trusted senders to anyone with disk read
 * access — the DIDs are recoverable only by knowing them already and
 * looking up the file. Salt isn't needed: the threat model is leakage
 * via directory enumeration, not preimage attacks against the hash.
 */
function didHash(did: string): string {
  return crypto.createHash('sha256').update(did).digest('hex');
}

/**
 * Clamp a tier value to the valid {0, 1, 2, 3} range. Non-integers and
 * out-of-range values default to 0 (untrusted) — fail-closed.
 *
 * Exported for direct unit testing; the production caller is
 * `resolveTrustTier`'s explicit-record branch.
 */
export function clampTier(tier: unknown): TrustTier {
  if (typeof tier !== 'number' || !Number.isInteger(tier)) return 0;
  if (tier < 0 || tier > 3) return 0;
  return tier as TrustTier;
}

async function resolveTrustTier(tenantCtx: TenantContext, did: string | null): Promise<TierResolutionResult> {
  if (!did || !DID_SAFE_PATTERN.test(did)) {
    return { tier: 0, actorRecord: null };
  }

  // Destination operator's explicit trust record wins if present — this is
  // how operators upgrade a specific sender to tier 2/3 or blacklist them.
  const recordPath = tenantDataPath(tenantCtx, 'trust-registry', didHash(did) + '.json');
  try {
    const record = JSON.parse(await fsp.readFile(recordPath, 'utf8')) as ActorRecord;
    // Defensive: a malformed registry record could carry a tier outside
    // {0,1,2,3}. Clamp before returning so a hand-edited bad value can't
    // smuggle elevated trust past the gate.
    const tier = clampTier(record.tier);
    return { tier, actorRecord: { ...record, tier } };
  } catch {
    // no explicit record — fall through
  }

  // Sender-signed delegation-chain fallback: any active Nova-registered agent
  // defaults to tier 1. The grant chain's Nova-signed root is the actual
  // authority; per-destination trust is operational admission control layered
  // on top of protocol-level identity. Forged `iss` DIDs that don't match a
  // registered agent still fall through to tier 0 (unknown actor).
  try {
    const agent = await getAgentByDid(getSharedRedis(), did);
    if (agent && agent.status === 'active') {
      return {
        tier: 1 as TrustTier,
        actorRecord: {
          did,
          displayName: agent.name,
          tier: 1,
          allowedSkills: ['*'],
          addedAt: new Date().toISOString(),
          addedBy: 'auto',
          notes: 'Default tier-1 for active Nova-registered agent (no explicit trust record).',
        },
      };
    }
  } catch {
    // Redis unavailable — degrade to no-default behaviour. Tier-0 below.
  }

  return { tier: 0, actorRecord: null };
}

/**
 * Read the agent's own DID from the data directory. Cached after first
 * read. The cache never invalidates within a process — if `nova.did`
 * changes (key rotation, did:key → did:web migration), the gate keeps
 * the old value until the service restarts.
 *
 * Production deployments treat DID changes as "restart all services"
 * events (the same change forces grant reissue across the agent fleet
 * anyway), so the lack of invalidation is intentional and not a bug.
 * Tests that mutate `nova.did` mid-run should restart the module.
 */
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

// ── UCAN verification reason → external GateErrorCode mapping ──────────────
//
// Maps the internal failure-reason strings emitted by `verifyUCAN` (in
// ucan-verifier.ts) onto the stable GateErrorCode set that the HTTP layer
// returns to callers. Operators alert on these codes; routing the right
// reason to the right code is what makes "UCAN_EXPIRED vs UCAN_INVALID_JWT
// vs UCAN_WRONG_AUDIENCE" mean what operators expect.
//
// Two families of reasons need to be handled:
//
//   1. Outer-token failures (`ucan_*`). These map to the corresponding
//      UCAN_* codes one-to-one and have been stable since v1.
//
//   2. Chain-walking failures (`chain_*`). Introduced in Phase 2B-A
//      (the chain-walker rewrite). Each one represents the same kind of
//      failure as an outer-token reason but detected at depth ≥ 1 in the
//      delegation chain. Mapped to the closest semantic match:
//
//        chain_no_root              → UCAN_WRONG_AUDIENCE
//          (the chain doesn't terminate at a link signed by this Nova;
//           the request isn't authorised for this audience at all)
//        chain_audience_mismatch    → UCAN_DID_MISMATCH
//          (a link's aud doesn't equal the previous link's iss)
//        chain_link_expired         → UCAN_EXPIRED
//        chain_capability_widened   → UCAN_INSUFFICIENT_CAPABILITY
//        chain_link_invalid_sig     → UCAN_INVALID_JWT
//        chain_link_malformed       → UCAN_INVALID_JWT
//        chain_link_missing_proof   → UCAN_INSUFFICIENT_CAPABILITY
//        chain_link_too_many_proofs → UCAN_INVALID_JWT
//        chain_too_deep             → UCAN_INVALID_JWT
//        chain_root_has_proofs      → UCAN_INVALID_JWT
//        chain_peer_untrusted       → UCAN_WRONG_AUDIENCE
//          (peer Nova in the federation chain isn't in trusted-issuers)
//
// Unknown reasons fall through to UCAN_INVALID_JWT — the safest default
// for a code path that shouldn't be reachable in normal operation.
//
// Pre-2B-A, this map referenced `grant_*` keys (the old single-link
// verifier's reason names). Those reasons are no longer emitted by the
// verifier; removing the stale entries prevents accidentally "matching"
// them from a future caller that resurrects the names.

const REASON_TO_ERROR_CODE: Record<string, GateErrorCode> = {
  // Outer-token failures
  ucan_malformed: 'UCAN_INVALID_JWT',
  ucan_invalid_signature: 'UCAN_INVALID_JWT',
  ucan_invalid_jwt: 'UCAN_INVALID_JWT',
  ucan_expired: 'UCAN_EXPIRED',
  ucan_wrong_audience: 'UCAN_WRONG_AUDIENCE',
  ucan_did_mismatch: 'UCAN_DID_MISMATCH',
  ucan_insufficient_capability: 'UCAN_INSUFFICIENT_CAPABILITY',
  ucan_no_proof: 'UCAN_INSUFFICIENT_CAPABILITY',
  ucan_revoked: 'UCAN_REVOKED',
  revocation_check_failed: 'UCAN_REVOKED',

  // Chain-walking failures (Phase 2B-A and later)
  chain_no_root: 'UCAN_WRONG_AUDIENCE',
  chain_audience_mismatch: 'UCAN_DID_MISMATCH',
  chain_link_expired: 'UCAN_EXPIRED',
  chain_capability_widened: 'UCAN_INSUFFICIENT_CAPABILITY',
  chain_link_invalid_signature: 'UCAN_INVALID_JWT',
  chain_link_malformed: 'UCAN_INVALID_JWT',
  chain_link_missing_proof: 'UCAN_INSUFFICIENT_CAPABILITY',
  chain_link_too_many_proofs: 'UCAN_INVALID_JWT',
  chain_too_deep: 'UCAN_INVALID_JWT',
  chain_root_has_proofs: 'UCAN_INVALID_JWT',
  chain_peer_untrusted: 'UCAN_WRONG_AUDIENCE',
};

export function mapReasonToGateErrorCode(reason: string | undefined): GateErrorCode {
  return REASON_TO_ERROR_CODE[reason ?? ''] ?? 'UCAN_INVALID_JWT';
}
