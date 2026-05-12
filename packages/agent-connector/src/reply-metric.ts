// Maps a ReplyDeliveryOutcome (from @nova/task-queue's deliverReply) onto
// the connector's `deliveryOutcomes` counter label. webhook_failed_dlq and
// broker_sender_inactive_dlq count as 'permanent_failure' rather than
// 'transient' because deliverReply has already persisted the result to the
// DLQ — operator intervention, not retry, is what closes the gap.
import type { ReplyDeliveryOutcome } from '@nova/task-queue/src/reply-delivery';

export function replyMetricOutcome(
  outcome: ReplyDeliveryOutcome,
): 'success' | 'permanent_failure' | 'transient_failure' {
  switch (outcome) {
    case 'webhook_delivered':
    case 'broker_queued':
      return 'success';
    case 'webhook_failed_dlq':
    case 'broker_sender_inactive_dlq':
    case 'no_target':
      return 'permanent_failure';
    case 'broker_enqueue_failed':
      return 'transient_failure';
  }
}
