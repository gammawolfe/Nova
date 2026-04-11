import fs from 'fs';
import path from 'path';
import { TenantContext } from '@nova/shared/src/tenant';
import { GateErrorCode, NovaError } from '@nova/shared/src/errors';
import { TrustTier, ActorRecord } from '@nova/shared/src/types';

export interface GateContext {
  tenantCtx: TenantContext;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export interface GateResult {
  passed: boolean;
  errorCode?: GateErrorCode;
  reason?: string;
  ucanJwt?: string;
  senderDid?: string;
  trustTier?: TrustTier;
  parsedTask?: any; // Finalized task after schema application
}

/**
 * Executes the synchronous 5-layer Gate pipeline. 
 * Rejects immediately upon encountering any violation.
 */
export async function executeGatePipeline(ctx: GateContext): Promise<GateResult> {
  const result: GateResult = { passed: true };

  try {
    // --- STEP 1: UCAN Pre-Extraction ---
    // Enforce Authorization: UCAN {jwt} format
    const authHeader = ctx.headers['authorization'];
    if (!authHeader || typeof authHeader !== 'string') {
      throw new NovaError('UCAN_MISSING', 'Missing Authorization header');
    }

    const match = authHeader.match(/^UCAN\s+(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/);
    if (!match || !match[1]) {
      throw new NovaError('UCAN_INVALID_JWT', 'Authorization header must be in format: UCAN {jwt}');
    }
    
    result.ucanJwt = match[1];

    // Placeholder until Step 3 parses the DID out of UCAN payload logic
    // For Milestone 1 testing, we assume the ucan jwt string literal given IS the issuer did (as a mock) 
    // or we resolve based on header if provided (mock format logic here)
    const mockExtractedDid = ctx.headers['x-mock-did'] as string || 'did:example:stub';
    result.senderDid = mockExtractedDid;

    // --- STEP 2: Trust Tier Resolution ---
    // Look up the DID in the specific agent's isolated Trust Registry
    // If unknown, we default to Tier 0.
    result.trustTier = resolveTrustTier(ctx.tenantCtx, result.senderDid);

    if (result.trustTier === 0) {
      throw new NovaError('ACTOR_UNKNOWN', `DID ${result.senderDid} holds no registered trust tier.`);
    }

    // --- STEP 3: UCAN Signature & Expiry Verifier (STUB) ---
    // TODO: Verify chain cryptographically.
    
    // --- STEP 4: Schema Validation (STUB) ---
    // TODO: z.parse payload against specific agent skill definition
    result.parsedTask = ctx.body; // Mock passing it right through

    // --- STEP 5: Injection Classification Layer A (STUB) ---
    // TODO: Regex validation 

    return result;

  } catch (error: any) {
    if (error instanceof NovaError) {
      return {
        passed: false,
        errorCode: error.code as GateErrorCode,
        reason: error.message
      };
    }

    return {
      passed: false,
      errorCode: 'INTERNAL_ERROR',
      reason: error.message || 'Unknown catastrophic failure in Gate pipeline'
    };
  }
}

/**
 * Resolves local file-system isolation bounds to grab specific trust records 
 * matching the resolved Actor DID.
 */
const DID_SAFE_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._-]+$/;

function resolveTrustTier(tenantCtx: TenantContext, did: string): TrustTier {
  if (!DID_SAFE_PATTERN.test(did)) {
    return 0; // Reject malformed DIDs that could enable path traversal
  }

  const dataRoot = process.env.DATA_ROOT || path.resolve(process.cwd(), '../../data');
  const recordPath = path.join(
    dataRoot,
    'tenants',
    tenantCtx.tenantId,
    'agents',
    tenantCtx.agentId,
    'trust-registry',
    `${did.replace(/:/g, '_')}.json`
  );

  if (!fs.existsSync(recordPath)) {
    return 0; // Explicitly map to isolated unknown limits.
  }

  try {
    const raw = fs.readFileSync(recordPath, 'utf8');
    const record = JSON.parse(raw) as ActorRecord;
    return record.tier as TrustTier;
  } catch (err) {
    // Treat corrupt local DB files securely as failed state.
    return 0; 
  }
}
