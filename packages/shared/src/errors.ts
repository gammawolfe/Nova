export type GateErrorCode =
  | 'ACTOR_UNKNOWN'
  | 'UCAN_MISSING'
  | 'UCAN_INVALID_JWT'
  | 'UCAN_EXPIRED'
  | 'UCAN_REVOKED'
  | 'UCAN_DID_MISMATCH'
  | 'UCAN_WRONG_AUDIENCE'
  | 'UCAN_INSUFFICIENT_CAPABILITY'
  | 'UCAN_CLAIM_EXPIRED'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'SCHEMA_INVALID'
  | 'TASK_TTL_EXPIRED_AT_INGRESS'
  | 'INTENT_UNKNOWN'
  | 'INTENT_NOT_IN_ACTOR_ALLOWLIST'
  | 'INJECTION_PATTERN_MATCH'
  | 'INJECTION_DETECTED'
  | 'INJECTION_SUSPECTED'
  | 'CLASSIFIER_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'RATE_LIMITED'
  | 'PROTOCOL_VERSION_UNSUPPORTED';

export type ExecutionErrorCode =
  | 'TTL_EXPIRED'
  | 'HUMAN_DENIED'
  | 'CONFIRMATION_TIMEOUT'
  | 'INTERNAL_ERROR'
  | 'CANNOT_COMPLETE';

export class NovaError extends Error {
  constructor(
    public readonly code: GateErrorCode | ExecutionErrorCode | string,
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'NovaError';
  }
}
