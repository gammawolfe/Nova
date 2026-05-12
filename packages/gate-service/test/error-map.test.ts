// packages/gate-service/test/error-map.test.ts
//
// Pins the verification-reason → GateErrorCode mapping. This is the layer
// that decides what HTTP error code operators see when a UCAN fails — so
// every failure reason emitted by verifyUCAN must map to the right
// alerting bucket.
//
// Phase 2B-A renamed the single-link `grant_*` reasons to chain-walk
// `chain_*` reasons. Pipeline's local errorMap wasn't updated at the time;
// federation chain failures fell through to UCAN_INVALID_JWT instead of
// the specific code operators expected. These tests prevent that regression
// from recurring.

import { describe, it, expect } from 'vitest';
import { mapReasonToGateErrorCode } from '../src/pipeline';

describe('mapReasonToGateErrorCode — outer-token failures', () => {
  it('ucan_malformed → UCAN_INVALID_JWT', () => {
    expect(mapReasonToGateErrorCode('ucan_malformed')).toBe('UCAN_INVALID_JWT');
  });

  it('ucan_invalid_signature → UCAN_INVALID_JWT', () => {
    expect(mapReasonToGateErrorCode('ucan_invalid_signature')).toBe('UCAN_INVALID_JWT');
  });

  it('ucan_expired → UCAN_EXPIRED', () => {
    expect(mapReasonToGateErrorCode('ucan_expired')).toBe('UCAN_EXPIRED');
  });

  it('ucan_wrong_audience → UCAN_WRONG_AUDIENCE', () => {
    expect(mapReasonToGateErrorCode('ucan_wrong_audience')).toBe('UCAN_WRONG_AUDIENCE');
  });

  it('ucan_insufficient_capability → UCAN_INSUFFICIENT_CAPABILITY', () => {
    expect(mapReasonToGateErrorCode('ucan_insufficient_capability'))
      .toBe('UCAN_INSUFFICIENT_CAPABILITY');
  });

  it('ucan_no_proof → UCAN_INSUFFICIENT_CAPABILITY', () => {
    expect(mapReasonToGateErrorCode('ucan_no_proof')).toBe('UCAN_INSUFFICIENT_CAPABILITY');
  });

  it('ucan_revoked → UCAN_REVOKED', () => {
    expect(mapReasonToGateErrorCode('ucan_revoked')).toBe('UCAN_REVOKED');
  });

  it('revocation_check_failed → UCAN_REVOKED (fail-closed)', () => {
    expect(mapReasonToGateErrorCode('revocation_check_failed')).toBe('UCAN_REVOKED');
  });
});

describe('mapReasonToGateErrorCode — chain-walking failures (Phase 2B-A regression guard)', () => {
  // The bug this test set protects against: when the verifier was rewritten
  // for arbitrary-depth chains, these reasons replaced the old grant_*
  // names but the pipeline's local errorMap was not updated. Every chain
  // failure then fell through to UCAN_INVALID_JWT, masking specific
  // operator-monitored codes like UCAN_EXPIRED and UCAN_WRONG_AUDIENCE.

  it('chain_no_root → UCAN_WRONG_AUDIENCE', () => {
    // The chain doesn't terminate at a link signed by this Nova; the
    // request isn't authorised for this audience.
    expect(mapReasonToGateErrorCode('chain_no_root')).toBe('UCAN_WRONG_AUDIENCE');
  });

  it('chain_audience_mismatch → UCAN_DID_MISMATCH', () => {
    expect(mapReasonToGateErrorCode('chain_audience_mismatch')).toBe('UCAN_DID_MISMATCH');
  });

  it('chain_link_expired → UCAN_EXPIRED', () => {
    expect(mapReasonToGateErrorCode('chain_link_expired')).toBe('UCAN_EXPIRED');
  });

  it('chain_capability_widened → UCAN_INSUFFICIENT_CAPABILITY', () => {
    expect(mapReasonToGateErrorCode('chain_capability_widened'))
      .toBe('UCAN_INSUFFICIENT_CAPABILITY');
  });

  it('chain_link_invalid_signature → UCAN_INVALID_JWT', () => {
    expect(mapReasonToGateErrorCode('chain_link_invalid_signature')).toBe('UCAN_INVALID_JWT');
  });

  it('chain_link_malformed → UCAN_INVALID_JWT', () => {
    expect(mapReasonToGateErrorCode('chain_link_malformed')).toBe('UCAN_INVALID_JWT');
  });

  it('chain_link_missing_proof → UCAN_INSUFFICIENT_CAPABILITY', () => {
    expect(mapReasonToGateErrorCode('chain_link_missing_proof'))
      .toBe('UCAN_INSUFFICIENT_CAPABILITY');
  });

  it('chain_link_too_many_proofs → UCAN_INVALID_JWT', () => {
    expect(mapReasonToGateErrorCode('chain_link_too_many_proofs')).toBe('UCAN_INVALID_JWT');
  });

  it('chain_too_deep → UCAN_INVALID_JWT', () => {
    expect(mapReasonToGateErrorCode('chain_too_deep')).toBe('UCAN_INVALID_JWT');
  });

  it('chain_root_has_proofs → UCAN_INVALID_JWT', () => {
    expect(mapReasonToGateErrorCode('chain_root_has_proofs')).toBe('UCAN_INVALID_JWT');
  });

  it('chain_peer_untrusted → UCAN_WRONG_AUDIENCE', () => {
    expect(mapReasonToGateErrorCode('chain_peer_untrusted')).toBe('UCAN_WRONG_AUDIENCE');
  });
});

describe('mapReasonToGateErrorCode — fallthrough', () => {
  it('unknown reason → UCAN_INVALID_JWT (safe default)', () => {
    expect(mapReasonToGateErrorCode('some_future_unknown_reason')).toBe('UCAN_INVALID_JWT');
  });

  it('undefined reason → UCAN_INVALID_JWT', () => {
    expect(mapReasonToGateErrorCode(undefined)).toBe('UCAN_INVALID_JWT');
  });

  it('empty-string reason → UCAN_INVALID_JWT', () => {
    expect(mapReasonToGateErrorCode('')).toBe('UCAN_INVALID_JWT');
  });

  it('stale grant_* reasons fall through (they are no longer emitted)', () => {
    // grant_not_from_nova, grant_wrong_audience, etc. were emitted by the
    // pre-Phase-2B-A verifier. Keeping them in the map invited "match-by-
    // mistake" if any future caller resurrected those names. They now
    // fall through to the default, which is the conservative behaviour.
    expect(mapReasonToGateErrorCode('grant_not_from_nova')).toBe('UCAN_INVALID_JWT');
    expect(mapReasonToGateErrorCode('grant_expired')).toBe('UCAN_INVALID_JWT');
    expect(mapReasonToGateErrorCode('grant_does_not_subsume_invocation')).toBe('UCAN_INVALID_JWT');
  });
});
