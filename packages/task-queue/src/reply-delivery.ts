// packages/task-queue/src/reply-delivery.ts
//
// Centralises reply-routing: given a TaskResult produced by a recipient
// agent, deliver it back to the original sender via the appropriate
// channel. The three branches and their failure-mode handling used to
// live inline in a2a-server's routes/inbox.ts respond handler; pulling
// them here keeps the protocol logic out of the HTTP layer and gives
// it a clean test surface.
//
// Branches:
//   1. replyTo URL set         → POST the TaskResult; on failure (timeout,
//                                non-2xx, network error) DLQ it under the
//                                sender's ctx so the operator can resubmit.
//                                Closes the asymmetric correctness gap
//                                where webhook failures previously logged
//                                and returned 202 without persistence.
//   2. Sender Nova-registered  → enqueue to the sender's broker reply
//                                inbox. If the sender is inactive at
//                                respond time, DLQ + audit event so the
//                                operator can re-activate and replay.
//   3. Neither                 → log a warning. Ingress should have
//                                rejected this case (a2a-server already
//                                returns 400 REPLY_TARGET_UNRESOLVED when
//                                no replyTo and no registered sender);
//                                reaching here is a bug.
//
// All audit events emit from inside deliverReply so callers can't drift
// in the events they log. The recipient ctx is used as the audit subject
// because the audit log models "what did this recipient agent do?";
// the sender ctx is used only for routing destinations (DLQ, reply-inbox).

import type { TenantContext } from '@nova/shared/src/tenant';
import type { TaskResult } from '@nova/shared/src/types';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { getAgentMeta } from '@nova/shared/src/agent-index';
import { getSharedRedis } from '@nova/shared/src/redis';
import * as replyInbox from './reply-inbox';
import { writeDeadLetter } from './dead-letter';

/**
 * Per-attempt timeout on the webhook POST. Matches the original inline
 * value in routes/inbox.ts; conservative enough that a slow receiver
 * won't pin a respond request, aggressive enough to surface a dead
 * webhook to the DLQ on the first attempt rather than after a long hang.
 */
const REPLY_WEBHOOK_TIMEOUT_MS = 10_000;

export type ReplyDeliveryOutcome =
  | 'webhook_delivered'
  | 'webhook_failed_dlq'
  | 'broker_queued'
  | 'broker_sender_inactive_dlq'
  | 'broker_enqueue_failed'
  | 'no_target';

export interface DeliverReplyOpts {
  /** Webhook URL to POST the TaskResult to, if any. */
  replyTo?: string;
  /** Sender's tenant for broker-mode reply enqueue, if any. */
  senderTenantId?: string;
  /** Sender's agent for broker-mode reply enqueue, if any. */
  senderAgentId?: string;
  /** Recipient ctx — used as the audit-log subject (who responded). */
  recipientCtx: TenantContext;
  /**
   * Pre-serialized TaskResult JSON. Optional — callers that already
   * stringified the body (e.g. for a size cap) can pass it to avoid a
   * second JSON.stringify on the hot path.
   */
  serializedResult?: string;
}

export async function deliverReply(
  taskId: string,
  result: TaskResult,
  opts: DeliverReplyOpts,
): Promise<ReplyDeliveryOutcome> {
  const serialized = opts.serializedResult ?? JSON.stringify(result);
  const { recipientCtx, replyTo, senderTenantId, senderAgentId } = opts;

  if (replyTo) return deliverWebhook(taskId, result, serialized, replyTo, opts);
  if (senderTenantId && senderAgentId) {
    return deliverBroker(taskId, result, recipientCtx, { tenantId: senderTenantId, agentId: senderAgentId });
  }

  logger.warn(
    { taskId },
    'Reply delivery: neither replyTo nor senderAgentId present — ingress should have rejected this',
  );
  return 'no_target';
}

async function deliverWebhook(
  taskId: string,
  result: TaskResult,
  serialized: string,
  replyTo: string,
  opts: DeliverReplyOpts,
): Promise<ReplyDeliveryOutcome> {
  const { recipientCtx, senderTenantId, senderAgentId } = opts;
  try {
    const response = await fetch(replyTo, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialized,
      signal: AbortSignal.timeout(REPLY_WEBHOOK_TIMEOUT_MS),
    });
    // Non-2xx is a delivery failure. Without this check, a sender that
    // returns 500 on a malformed webhook still got a 202 from us and
    // the result evaporated silently.
    if (!response.ok) {
      throw new Error(`webhook returned HTTP ${response.status}`);
    }
    await auditLog(recipientCtx, {
      event: 'reply_delivered',
      taskId,
      metadata: { target: 'webhook' },
    });
    return 'webhook_delivered';
  } catch (err: any) {
    // Symmetry with the broker-mode sender-inactive branch — persist the
    // undelivered result to the sender's DLQ when we know the sender ctx,
    // otherwise to the recipient's so it isn't dropped on the floor.
    const dlqCtx: TenantContext =
      senderTenantId && senderAgentId
        ? { tenantId: senderTenantId, agentId: senderAgentId }
        : recipientCtx;
    await writeDeadLetter(dlqCtx, {
      taskId,
      targetUrl: replyTo,
      taskResult: result,
      failureReason: 'reply_webhook_failed',
      httpStatus: 0,
      attemptCount: 1,
    });
    await auditLog(recipientCtx, {
      event: 'reply_webhook_failed',
      taskId,
      metadata: { replyTo, error: err?.message ?? 'unknown' },
    });
    logger.warn(
      { err: err?.message, taskId, replyTo },
      'Reply delivery: webhook POST failed; result written to dead-letter',
    );
    return 'webhook_failed_dlq';
  }
}

async function deliverBroker(
  taskId: string,
  result: TaskResult,
  recipientCtx: TenantContext,
  senderCtx: TenantContext,
): Promise<ReplyDeliveryOutcome> {
  const senderMeta = await getAgentMeta(getSharedRedis(), senderCtx.agentId);
  if (!senderMeta || senderMeta.status !== 'active') {
    // Sender deregistered or suspended between send and respond —
    // result is undeliverable. Persist to DLQ for operator review.
    await writeDeadLetter(senderCtx, {
      taskId,
      targetUrl: 'broker-reply',
      taskResult: result,
      failureReason: 'reply_sender_inactive',
      httpStatus: 0,
      attemptCount: 1,
    });
    await auditLog(recipientCtx, {
      event: 'reply_sender_inactive',
      taskId,
      metadata: {
        senderTenantId: senderCtx.tenantId,
        senderAgentId: senderCtx.agentId,
        senderStatus: senderMeta?.status ?? 'missing',
      },
    });
    logger.warn(
      { taskId, senderAgentId: senderCtx.agentId, senderStatus: senderMeta?.status ?? 'missing' },
      'Reply delivery: sender inactive; result written to dead-letter',
    );
    return 'broker_sender_inactive_dlq';
  }

  try {
    await replyInbox.enqueueReply(senderCtx, taskId, result);
    await auditLog(recipientCtx, {
      event: 'reply_broker_queued',
      taskId,
      metadata: { senderTenantId: senderCtx.tenantId, senderAgentId: senderCtx.agentId },
    });
    return 'broker_queued';
  } catch (err: any) {
    // Enqueue failures don't currently DLQ — the failure could be
    // transient (Redis blip) and a retry by the sender via idempotent
    // resubmit will redrive the whole task. Log loudly so the operator
    // can correlate; this is the only branch without persistence.
    logger.error(
      { err: err?.message, taskId, senderAgentId: senderCtx.agentId },
      'Reply delivery: reply-inbox enqueue failed',
    );
    return 'broker_enqueue_failed';
  }
}
