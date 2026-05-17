import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { TenantContext, tenantDataPath, KEY_ROOT } from '@nova/shared/src/tenant';
import { GateErrorCode } from '@nova/shared/src/errors';
import { TrustTier, ActorRecord, TaskRequest } from '@nova/shared/src/types';
import { auditLog } from '@nova/shared/src/audit';
import { logger } from '@nova/shared/src/logger';
import { getSharedRedis } from '@nova/shared/src/redis';
import { getAgentByDid } from '@nova/shared/src/agent-index';
import { verifyUCAN, extractIssuerDid, UCANVerificationResult } from './ucan-verifier';
import { validateSchema } from './schema-validator';
import { extractStrings, patternMatch, llmClassify, classifyDecision } from './classifier';
import { writeQuarantine } from './quarantine';
import { gateDecisions, gateLatency, classifierResults } from './metrics';
import { loadEffectiveClassifierConfig } from '@nova/shared/src/classifier-config';

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
  /**
   * When the sender DID resolves to a registered Nova agent, surface
   * the agent's tenantId/agentId so the ingress handler can route
   * broker-mode replies without a second Redis hop. Populated only by
   * the getAgentByDid branch of tier resolution; external (non-Nova)
   * senders with explicit trust records leave these undefined.
   */
  senderTenantId?: string | undefined;
  senderAgentId?: string | undefined;
  trustTier?: TrustTier | undefined;
  parsedTask?: unknown;
}

// ── Step combinator ────────────────────────────────────────────────────────
//
// Each pipeline step returns a discriminated union. `pass` means the step
// completed and produced a value for the next step; `fail` means the step
// short-circuited with a finalised GateResult that the orchestrator wraps
// and returns.
//
// This shape keeps the orchestrator's control flow explicit (no Promise
// chains, no error-as-control-flow throws) while moving each step's
// audit + quarantine plumbing into its own named function. Each step
// function is independently readable and unit-testable.

type StepPass<T> = { kind: 'pass'; value: T };
type StepFail = { kind: 'fail'; result: GateResult };
type Step<T> = StepPass<T> | StepFail;

function pass<T>(value: T): StepPass<T> {
  return { kind: 'pass', value };
}

function fail(result: GateResult): StepFail {
  return { kind: 'fail', result };
}

/**
 * Executes the 5-layer Gate pipeline. Returns a GateResult describing
 * whether the task was accepted, quarantined, or dropped.
 *
 * The orchestrator stays thin: extract auth from headers, run each step
 * in order, short-circuit on the first failure. Each step encapsulates
 * its own audit + quarantine logic; see runTierStep, runUcanStep,
 * runSchemaStep, runClassifyStep below.
 */
export async function executeGatePipeline(ctx: GateContext): Promise<GateResult> {
  const { tenantCtx } = ctx;
  const receivedAt = new Date().toISOString();
  const endTimer = gateLatency.startTimer();

  const recordAndReturn = (result: GateResult): GateResult => {
    endTimer();
    gateDecisions.inc({ decision: result.decision, error_code: result.errorCode ?? 'none' });
    // Note: prior versions did a fsp.readdir on the quarantine directory
    // here to update the quarantineDepth gauge. Removed in favour of the
    // `nova_gate_decisions_total{decision="quarantined"}` counter, which
    // gives operators the same information without disk I/O. See PR #73.
    return result;
  };

  // Step 1: Auth header extraction (pure, no I/O).
  const { ucanJwt, senderDid } = extractAuth(ctx.headers);

  // Step 2: Trust tier resolution.
  const tier = await runTierStep({ tenantCtx, body: ctx.body, receivedAt, senderDid });
  if (tier.kind === 'fail') return recordAndReturn(tier.result);

  // Step 3: UCAN verification. Need agent DID first.
  const agentDid = ctx.agentDid ?? await loadAgentDid();
  const ucan = await runUcanStep({
    tenantCtx, body: ctx.body, receivedAt, senderDid,
    tier: tier.value.tier, ucanJwt, agentDid,
  });
  if (ucan.kind === 'fail') return recordAndReturn(ucan.result);

  // Step 4: Schema validation.
  const schema = await runSchemaStep({ tenantCtx, body: ctx.body, senderDid, tier: tier.value.tier });
  if (schema.kind === 'fail') return recordAndReturn(schema.result);

  // Step 5: Injection classification (pattern match + LLM).
  const params = (schema.value.params ?? {}) as Record<string, unknown>;
  const classify = await runClassifyStep({
    tenantCtx, body: ctx.body, receivedAt, senderDid,
    tier: tier.value.tier, params,
  });
  if (classify.kind === 'fail') return recordAndReturn(classify.result);

  return recordAndReturn({
    passed: true,
    decision: 'accepted',
    ucanJwt: ucanJwt ?? undefined,
    senderDid: senderDid ?? undefined,
    ...(tier.value.senderAgent
      ? {
          senderTenantId: tier.value.senderAgent.tenantId,
          senderAgentId: tier.value.senderAgent.agentId,
        }
      : {}),
    trustTier: tier.value.tier,
    parsedTask: schema.value,
  });
}

// ── Step 1: Auth extraction (synchronous, pure) ────────────────────────────

function extractAuth(headers: GateContext['headers']): {
  ucanJwt: string | null;
  senderDid: string | null;
} {
  const authHeader = headers['authorization'];
  let ucanJwt: string | null = null;
  if (authHeader && typeof authHeader === 'string') {
    const match = authHeader.match(/^UCAN\s+(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/);
    if (match?.[1]) ucanJwt = match[1];
  }

  // Extract DID from UCAN for trust tier lookup (without full verification yet).
  // Forged or malformed iss values fall through to senderDid=null, which the
  // tier step treats as tier 0 (quarantine).
  const senderDid = ucanJwt ? extractIssuerDid(ucanJwt) : null;
  return { ucanJwt, senderDid };
}

// ── Step 2: Trust tier resolution ──────────────────────────────────────────

interface TierStepArgs {
  tenantCtx: TenantContext;
  body: unknown;
  receivedAt: string;
  senderDid: string | null;
}

async function runTierStep(args: TierStepArgs): Promise<Step<TierResolutionResult>> {
  const { tenantCtx, body, receivedAt, senderDid } = args;
  const resolved = await resolveTrustTier(tenantCtx, senderDid);

  if (resolved.tier === 0) {
    await auditLog(tenantCtx, {
      event: 'actor_unknown',
      senderDid: senderDid ?? undefined,
      tier: 0,
      reason: 'No trust record found for sender DID',
    });

    const qId = await writeQuarantine(tenantCtx, {
      receivedAt,
      senderDid,
      rawTask: body,
      gateStep: 'tier',
      reason: 'actor_unknown',
    });

    if (!qId) {
      await auditLog(tenantCtx, { event: 'quarantine_full' });
    } else {
      await auditLog(tenantCtx, { event: 'task_quarantined', senderDid: senderDid ?? undefined, reason: 'actor_unknown' });
    }

    return fail({
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
    tier: resolved.tier,
  });

  return pass(resolved);
}

// ── Step 3: UCAN verification ──────────────────────────────────────────────

interface UcanStepArgs {
  tenantCtx: TenantContext;
  body: unknown;
  receivedAt: string;
  senderDid: string | null;
  tier: TrustTier;
  ucanJwt: string | null;
  agentDid: string;
}

async function runUcanStep(args: UcanStepArgs): Promise<Step<UCANVerificationResult>> {
  const { tenantCtx, body, receivedAt, senderDid, tier, ucanJwt, agentDid } = args;

  if (!ucanJwt) {
    // Missing UCAN → quarantine (not drop — operator may want to review).
    await auditLog(tenantCtx, {
      event: 'ucan_failed',
      senderDid: senderDid ?? undefined,
      tier,
      reason: 'ucan_missing',
    });

    const qId = await writeQuarantine(tenantCtx, {
      receivedAt,
      senderDid,
      rawTask: body,
      gateStep: 'ucan',
      reason: 'ucan_missing',
    });

    return fail({
      passed: false,
      decision: 'quarantined',
      errorCode: 'UCAN_MISSING',
      reason: 'Missing Authorization: UCAN {jwt} header',
      quarantineId: qId ?? undefined,
      senderDid: senderDid ?? undefined,
      trustTier: tier,
    });
  }

  // In the sender-signed delegation model the gate is the audience on every
  // invocation (aud = novaDid). The invocation's att must express a capability
  // for this specific destination agent — we allow any sub-scope under
  // `nova:<tenantId>:<agentId>:skill:*` (skill granularity is enforced later
  // in schema validation against the destination's registered skill list).
  const requiredScope = `nova:${tenantCtx.tenantId}:${tenantCtx.agentId}:skill:*`;
  const ucanResult = await verifyUCAN(ucanJwt, tenantCtx, agentDid, requiredScope);

  if (!ucanResult.valid) {
    // Chain-walking failures surface a depth (where in the chain we
    // stopped). Attach it to metadata so operators can distinguish a
    // failed single-link grant (chainDepth 1) from a failure deep in a
    // federation chain. The `reason` string still drives alerting;
    // metadata is for diagnostics.
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
      rawTask: body,
      gateStep: 'ucan',
      reason: ucanResult.reason ?? 'ucan_invalid',
    });

    return fail({
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
  // through a peer Nova — peerDid identifies which.
  const verifyMetadata: Record<string, unknown> = {};
  if (ucanResult.chainLength !== undefined) verifyMetadata.chainLength = ucanResult.chainLength;
  if (ucanResult.peerDid !== undefined) verifyMetadata.peerDid = ucanResult.peerDid;
  await auditLog(tenantCtx, {
    event: 'ucan_verified',
    senderDid: senderDid ?? undefined,
    tier,
    ...(Object.keys(verifyMetadata).length > 0 ? { metadata: verifyMetadata } : {}),
  });

  return pass(ucanResult);
}

// ── Step 4: Schema validation ──────────────────────────────────────────────

interface SchemaStepArgs {
  tenantCtx: TenantContext;
  body: unknown;
  senderDid: string | null;
  tier: TrustTier;
}

async function runSchemaStep(args: SchemaStepArgs): Promise<Step<TaskRequest>> {
  const { tenantCtx, body, senderDid, tier } = args;
  const schemaResult = await validateSchema(body, tenantCtx);

  if (!schemaResult.valid) {
    await auditLog(tenantCtx, {
      event: 'schema_invalid',
      senderDid: senderDid ?? undefined,
      tier,
      reason: schemaResult.reason,
    });

    // Schema failures → DROP (not quarantine) — sender bug.
    return fail({
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

  // schemaResult.valid === true implies schemaResult.parsedTask is set;
  // schema-validator's contract is "parsedTask is defined iff valid is true."
  return pass(schemaResult.parsedTask as TaskRequest);
}

// ── Step 5: Injection classification (pattern match + LLM) ─────────────────

interface ClassifyStepArgs {
  tenantCtx: TenantContext;
  body: unknown;
  receivedAt: string;
  senderDid: string | null;
  tier: TrustTier;
  params: Record<string, unknown>;
}

async function runClassifyStep(args: ClassifyStepArgs): Promise<Step<void>> {
  const { tenantCtx, body, receivedAt, senderDid, tier, params } = args;

  // Stage A — synchronous pattern matching.
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
      rawTask: body,
      gateStep: 'classifier',
      reason: `injection_pattern_match:${patternResult.pattern}`,
    });

    classifierResults.inc({ result: 'quarantine', stage: 'pattern' });
    return fail({
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

  // Stage B — LLM classification with fail-open/fail-closed switch.
  const classifierConfig = await loadEffectiveClassifierConfig();
  if (!classifierConfig.aiEnabled) {
    const reason = classifierConfig.mode === 'pattern_only'
      ? 'LLM classifier disabled by mode=pattern_only'
      : (!classifierConfig.apiKey ? 'No classifier API key configured; LLM classifier skipped' : 'No classifier model configured; LLM classifier skipped');
    await auditLog(tenantCtx, {
      event: 'classifier_unavailable',
      senderDid: senderDid ?? undefined,
      tier,
      reason,
      metadata: {
        failMode: 'disabled',
        mode: classifierConfig.mode,
        apiKeySource: classifierConfig.apiKeySource,
      },
    });
    classifierResults.inc({ result: 'disabled', stage: 'llm' });
    return pass(undefined);
  }

  try {
    const llmResult = await llmClassify(strings, tenantCtx, { config: classifierConfig });
    const decision = classifyDecision(llmResult);

    if (decision === 'quarantine') {
      const confidenceHigh = llmResult.confidence >= 0.85;
      const reason = confidenceHigh
        ? `injection_detected:confidence=${llmResult.confidence}`
        : `injection_suspected:confidence=${llmResult.confidence}`;
      const errorCode: GateErrorCode = confidenceHigh ? 'INJECTION_DETECTED' : 'INJECTION_SUSPECTED';

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
        rawTask: body,
        gateStep: 'classifier',
        reason,
      });

      classifierResults.inc({ result: 'quarantine', stage: 'llm' });
      return fail({
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
    return pass(undefined);
  } catch (err: any) {
    if (classifierConfig.failClosed) {
      await auditLog(tenantCtx, {
        event: 'classifier_unavailable',
        senderDid: senderDid ?? undefined,
        tier,
        reason: err.message,
      });
      const qId = await writeQuarantine(tenantCtx, {
        receivedAt,
        senderDid,
        rawTask: body,
        gateStep: 'classifier',
        reason: `classifier_unavailable:${err.message}`,
      });
      classifierResults.inc({ result: 'quarantine', stage: 'llm_error' });
      return fail({
        passed: false,
        decision: 'quarantined',
        errorCode: 'CLASSIFIER_UNAVAILABLE',
        reason: `LLM classifier unavailable: ${err.message}`,
        quarantineId: qId ?? undefined,
        senderDid: senderDid ?? undefined,
        trustTier: tier,
      });
    }

    // Classifier unavailable + failClosed=false → fail-open:
    // skip layer-5 LLM injection detection and let the request through.
    // Layers 1-4 (tier, UCAN, schema, pattern-match) still ran.
    await auditLog(tenantCtx, {
      event: 'classifier_unavailable',
      senderDid: senderDid ?? undefined,
      tier,
      reason: err.message,
      metadata: { failMode: 'open', mode: classifierConfig.mode, apiKeySource: classifierConfig.apiKeySource },
    });
    classifierResults.inc({ result: 'fail_open', stage: 'llm_error' });
    logger.warn(
      { err: err.message },
      'LLM classifier unavailable — fail-open enabled, injection detection bypassed'
    );
    return pass(undefined);
  }
}

// ── Trust tier resolution ──────────────────────────────────────────────────

const DID_SAFE_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._-]+$/;

interface TierResolutionResult {
  tier: TrustTier;
  actorRecord: ActorRecord | null;
  /**
   * Populated when tier resolution went through the getAgentByDid
   * branch (sender is a registered Nova agent). Lets the ingress
   * handler route broker-mode replies without re-running the same
   * Redis lookup.
   */
  senderAgent?: { tenantId: string; agentId: string };
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
        senderAgent: { tenantId: agent.tenantId, agentId: agent.agentId },
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
// Outer-token reasons (`ucan_*`) map directly to UCAN_* codes; chain-walk
// reasons (`chain_*`, introduced in Phase 2B-A) map to the closest
// semantic match.

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
