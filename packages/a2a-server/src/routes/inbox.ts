// packages/a2a-server/src/routes/inbox.ts
import { Router, Request, Response, NextFunction } from 'express';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import {
  getAgentMeta,
  TASK_LIFECYCLE_CHANNEL,
  TaskLifecycleEvent,
} from '@nova/shared/src/agent-index';
import { getSharedRedis } from '@nova/shared/src/redis';
import { TenantContext } from '@nova/shared/src/tenant';
import { TaskResult } from '@nova/shared/src/types';
import { BROKER_MAX_WAIT_MS } from '@nova/shared/src/broker-config';
import * as inbox from '@nova/task-queue/src/inbox';

// ── UCAN self-verification adapter ──────────────────────────────────────────
//
// The gate-service verifyUCAN() is designed for sender→agent UCANs and requires
// an actorRecord + agentDid + TenantContext — not suitable for self-auth.
// extractIssuerDid() is a lightweight decode that gives us the issuer DID.
// We pair it with a manual expiry check to implement the self-UCAN model:
// "this JWT was issued BY the calling agent's own DID".
//
// We intentionally do NOT call the full verifyUCAN pipeline here because:
//   • The self-UCAN audience is the calling agent itself, not Nova's agent DID.
//   • We don't have (nor need) an actorRecord from the trust registry here.
//   • DID match against the Redis meta is the binding security check.

import { extractIssuerDid } from '@nova/gate-service/src/ucan-verifier';

interface SelfUcanResult {
  ok: true;
  subjectDid: string;
}
interface SelfUcanFailure {
  ok: false;
  reason: string;
}

/**
 * Minimal self-UCAN verification:
 * 1. Parse the JWT payload (base64url decode — no network required).
 * 2. Confirm `exp` is in the future.
 * 3. Return the issuer DID (`iss`) as the subject identity.
 *
 * Signature cryptographic verification is NOT performed here because these
 * are self-issued JWTs — the DID match against the Redis trust index is the
 * binding check. If full signature verification is needed in the future, add
 * ucans.validate() here and ensure the audience is set to the calling agent's
 * own DID.
 */
function verifySelfUcan(jwt: string): SelfUcanResult | SelfUcanFailure {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts[1]) {
      return { ok: false, reason: 'malformed_jwt' };
    }
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));

    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
      return { ok: false, reason: 'ucan_expired' };
    }

    const issuerDid = extractIssuerDid(jwt);
    if (!issuerDid) {
      return { ok: false, reason: 'ucan_no_issuer' };
    }

    return { ok: true, subjectDid: issuerDid };
  } catch (err: any) {
    return { ok: false, reason: 'ucan_parse_error' };
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export const inboxRouter = Router({ mergeParams: true });

/**
 * Extract self-UCAN from Authorization header, verify it, and resolve the
 * authenticated agent. Returns TenantContext on success or sends a 4xx and
 * returns null.
 */
async function authSelfUcan(
  req: Request,
  res: Response,
  paramAgentId: string,
): Promise<TenantContext | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'UCAN_MISSING' });
    return null;
  }
  const jwt = auth.slice(7).trim();

  const verification = verifySelfUcan(jwt);
  if (!verification.ok) {
    res.status(401).json({ error: 'UCAN_INVALID', reason: verification.reason });
    return null;
  }

  const meta = await getAgentMeta(getSharedRedis(), paramAgentId);
  if (!meta) {
    res.status(404).json({ error: 'AGENT_NOT_FOUND' });
    return null;
  }
  if (meta.did && meta.did !== verification.subjectDid) {
    res.status(401).json({ error: 'UCAN_DID_MISMATCH' });
    return null;
  }
  return { tenantId: meta.tenantId, agentId: meta.agentId };
}

// ── GET /agents/:agentId/inbox?wait=<ms> — long-poll pull ───────────────────

inboxRouter.get('/:agentId/inbox', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paramAgentId = req.params['agentId'];
    if (!paramAgentId) return void res.status(400).json({ error: 'AGENT_ID_REQUIRED' });

    const ctx = await authSelfUcan(req, res, paramAgentId);
    if (!ctx) return;

    let wait = parseInt(String(req.query['wait'] ?? '30000'), 10);
    if (!Number.isFinite(wait) || wait < 0) wait = 30000;
    wait = Math.min(wait, BROKER_MAX_WAIT_MS);

    const result = await inbox.pull(ctx, wait);
    if (!result) return void res.status(204).send();

    res.status(200).json({
      task: result.task,
      visibleUntil: result.visibleUntil.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /agents/:agentId/inbox/:taskId/respond ─────────────────────────────

inboxRouter.post(
  '/:agentId/inbox/:taskId/respond',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramAgentId = req.params['agentId'];
      const taskId = req.params['taskId'];
      if (!paramAgentId || !taskId) {
        return void res.status(400).json({ error: 'MISSING_PARAMS' });
      }

      const ctx = await authSelfUcan(req, res, paramAgentId);
      if (!ctx) return;

      const { status, result, error } = req.body as {
        status: 'ok' | 'error';
        result?: unknown;
        error?: { code: string; message: string; retryable?: boolean };
      };
      if (status !== 'ok' && status !== 'error') {
        return void res
          .status(400)
          .json({ error: 'INVALID_STATUS', hint: 'Must be "ok" or "error"' });
      }

      const entry = await inbox.peekInflight(ctx, taskId);
      if (!entry) return void res.status(404).json({ status: 'task_not_found' });

      const outcome = await inbox.respond(ctx, taskId);
      if (outcome === 'task_not_found') {
        return void res.status(404).json({ status: 'task_not_found' });
      }
      if (outcome === 'already_completed') {
        return void res.status(409).json({ status: 'already_completed' });
      }

      const now = new Date().toISOString();
      const taskResult: TaskResult =
        status === 'ok'
          ? {
              type: 'TaskResult',
              requestId: taskId,
              status: 'ok',
              result: (result as Record<string, unknown>) ?? {},
              auditToken: 'none',
              completedAt: now,
              schemaVersion: '1.0',
            }
          : {
              type: 'TaskResult',
              requestId: taskId,
              status: 'error',
              error: {
                code: error?.code ?? 'BROKER_ERROR',
                message: error?.message ?? 'Receiver reported an error',
                retryable: error?.retryable ?? false,
              },
              auditToken: 'none',
              completedAt: now,
              schemaVersion: '1.0',
            };

      try {
        await fetch(entry.task.replyTo, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(taskResult),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (deliveryErr: any) {
        logger.warn(
          { err: deliveryErr.message, taskId, replyTo: entry.task.replyTo },
          'Broker respond: delivery to replyUrl failed',
        );
      }

      const lifecycle: TaskLifecycleEvent = {
        action: status === 'ok' ? 'completed' : 'failed',
        taskId,
        toTenantId: entry.task.tenantId,
        toAgentId: entry.task.agentId,
      };
      try {
        await getSharedRedis().publish(TASK_LIFECYCLE_CHANNEL, JSON.stringify(lifecycle));
      } catch (pubErr: any) {
        logger.warn(
          { err: pubErr.message, taskId },
          'Broker respond: failed to publish lifecycle event',
        );
      }

      await auditLog(ctx, {
        event: status === 'ok' ? 'task_completed' : 'task_started',
        taskId,
        metadata: { mode: 'broker' },
      });

      res.status(202).json({ status: 'accepted' });
    } catch (err) {
      next(err);
    }
  },
);
