// Covers the outcome→metric mapping introduced when processTask's inline
// reply-routing was replaced by deliverReply. Two important policy points:
//   1. webhook_failed_dlq counts as 'permanent_failure' (not 'transient' as
//      the inline code used to record it) — deliverReply persists to the
//      DLQ on first attempt, so operator review is the next step, not retry.
//   2. broker_enqueue_failed stays 'transient_failure' — deliverReply does
//      not DLQ that branch, so a sender resubmit can recover it.
//
// This is the only path in PR #1 with new behavior beyond pure delegation;
// broader processTask tests land after PR #2 gates the module-level
// initWorkerManager / audit drain / reclaim worker side effects.

import { describe, it, expect } from 'vitest';
import { replyMetricOutcome } from '../src/reply-metric';

describe('replyMetricOutcome', () => {
  it('counts webhook_delivered as success', () => {
    expect(replyMetricOutcome('webhook_delivered')).toBe('success');
  });

  it('counts broker_queued as success', () => {
    expect(replyMetricOutcome('broker_queued')).toBe('success');
  });

  it('counts webhook_failed_dlq as permanent_failure (DLQ closes the retry loop)', () => {
    expect(replyMetricOutcome('webhook_failed_dlq')).toBe('permanent_failure');
  });

  it('counts broker_sender_inactive_dlq as permanent_failure', () => {
    expect(replyMetricOutcome('broker_sender_inactive_dlq')).toBe('permanent_failure');
  });

  it('counts no_target as permanent_failure (result was dropped)', () => {
    expect(replyMetricOutcome('no_target')).toBe('permanent_failure');
  });

  it('counts broker_enqueue_failed as transient_failure (no DLQ, sender can resubmit)', () => {
    expect(replyMetricOutcome('broker_enqueue_failed')).toBe('transient_failure');
  });
});
