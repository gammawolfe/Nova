// packages/a2a-server/src/routes/tasks.ts
//
// Per-agent task surface — ingress, status lookup, and the public agent
// card. These all live on the `agentRouter` (mounted at /agents/:agentId)
// so the tenantRouter middleware has already populated `req.ctx`.
//
// The rate-limit middleware applies only to POST /tasks; GET endpoints
// are cheap and unauthenticated reads.

import { Router, Request, Response } from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import fsp from 'fs/promises';
import { logger } from '@nova/shared/src/logger';
import { auditLog } from '@nova/shared/src/audit';
import { executeGatePipeline, GateContext } from '@nova/gate-service';
import { enqueueWithIdempotency, setTaskState, getTaskState } from '@nova/task-queue/src/index';
import { QueuedTask, TaskState } from '@nova/shared/src/types';
import { AgentCardSchema } from '@nova/shared/src/schemas';
import { tenantDataPath } from '@nova/shared/src/tenant';
import { GateErrorCode } from '@nova/shared/src/errors';
import { getBrokerPresence } from '@nova/shared/src/broker-presence';
import { keyManager } from '../key-manager';
import { createRateLimitMiddleware } from '../middleware/rate-limit';

export const tasksRouter = Router({ mergeParams: true });

const RATE_LIMIT_PER_SENDER = parseInt(process.env.RATE_LIMIT_PER_SENDER || '60', 10);
const RATE_LIMIT_GLOBAL_PER_AGENT = parseInt(process.env.RATE_LIMIT_GLOBAL_PER_AGENT || '300', 10);

// Inlined from the index.ts UCAN_ERROR_CODES Set — the single call site
// is the gate-failure branch in POST /tasks below, and a literal predicate
// reads more obviously than a separately-defined Set.
function isUcanErrorCode(code: GateErrorCode | undefined): boolean {
  return (
    code === 'UCAN_MISSING' ||
    code === 'UCAN_INVALID_JWT' ||
    code === 'UCAN_EXPIRED' ||
    code === 'UCAN_REVOKED' ||
    code === 'UCAN_DID_MISMATCH' ||
    code === 'UCAN_WRONG_AUDIENCE' ||
    code === 'UCAN_INSUFFICIENT_CAPABILITY'
  );
}

// H2 — strict default header set on the public agent card. Card is the
// only truly public-by-design surface here; every other route gates on
// UCAN, self-UCAN, or admin token.
const wellKnownHelmet = helmet({
  contentSecurityPolicy: { directives: { 'default-src': ["'none'"] } },
  crossOriginEmbedderPolicy: false, // not relevant for a JSON endpoint
});

// ── GET /.well-known/agent.json — public agent card ──────────────────────────

tasksRouter.get('/.well-known/agent.json', wellKnownHelmet, async (req: Request, res: Response) => {
  try {
    const configPath = tenantDataPath(req.ctx, 'agent-config.json');
    let raw: any;
    try {
      raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    } catch {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const card = {
      name: raw.name,
      description: raw.description,
      url: `${req.protocol}://${req.get('host')}/agents/${req.ctx.agentId}`,
      version: raw.version || '1.0.0',
      protocolVersions: ['1.0'] as const,
      capabilities: raw.capabilities || {
        streaming: true,
        pushNotifications: true,
        stateTransitionHistory: true,
      },
      authentication: raw.authentication || {
        schemes: ['ucan'],
        ucapabilityPrefix: `nova:${req.ctx.tenantId}:${req.ctx.agentId}`,
      },
      brokerPresence: await getBrokerPresence(req.ctx),
      skills: (raw.skills || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        tags: s.tags ?? [],
        inputSchema: s.inputSchema ?? {},
        outputSchema: s.outputSchema ?? {},
      })),
    };

    const parsed = AgentCardSchema.safeParse(card);
    if (!parsed.success) {
      logger.error({ errors: parsed.error.issues }, 'Agent card validation failed');
      return res.status(500).json({ error: 'Invalid agent configuration' });
    }

    res.json(parsed.data);
  } catch (err) {
    logger.error({ err }, 'Failed to serve agent card');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ── GET /tasks/:taskId — current task state ──────────────────────────────────

tasksRouter.get('/tasks/:taskId', async (req: Request, res: Response) => {
  const taskId = req.params['taskId'];
  if (!taskId) return res.status(400).json({ error: 'TASK_ID_REQUIRED' });
  try {
    const state = await getTaskState(req.ctx, taskId);
    if (!state) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(state);
  } catch (err) {
    logger.error({ err, taskId }, 'Failed to fetch task state');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ── POST /tasks — gate-fronted ingress ───────────────────────────────────────

const rateLimit = createRateLimitMiddleware({
  perSender: RATE_LIMIT_PER_SENDER,
  global: RATE_LIMIT_GLOBAL_PER_AGENT,
});

tasksRouter.post('/tasks', rateLimit, async (req: Request, res: Response) => {
  const ctx = req.ctx;
  const requestId = crypto.randomUUID();
  const senderIp = req.ip ?? '0.0.0.0';

  // --- Audit: message_received ---
  try {
    await auditLog(ctx, {
      event: 'message_received',
      senderDid: undefined,
      metadata: { requestId, senderIp },
    });
  } catch (err) {
    logger.error({ err }, 'Audit log write failed at ingress');
    return res.status(503).json({ error: 'INTERNAL_ERROR', message: 'Audit system unavailable' });
  }

  // --- Gate Pipeline ---
  const gateCtx: GateContext = {
    tenantCtx: ctx,
    headers: req.headers,
    body: req.body,
    senderIp,
    requestId,
    agentDid: keyManager.getDid(),
  };

  const gateResult = await executeGatePipeline(gateCtx);

  if (!gateResult.passed) {
    logger.warn({
      ctx,
      error: gateResult.errorCode,
      reason: gateResult.reason,
      decision: gateResult.decision,
    }, 'Task rejected at ingress gate');

    if (gateResult.decision === 'dropped') {
      const status = isUcanErrorCode(gateResult.errorCode) ? 401 : 403;
      return res.status(status).json({
        error: gateResult.errorCode,
        message: gateResult.reason,
      });
    }

    // Quarantined tasks still return 202 (gate decision is internal).
    return res.status(202).json({
      status: 'quarantined',
      reason: gateResult.reason,
      quarantineId: gateResult.quarantineId,
    });
  }

  // --- Map to Queue ---
  const generatedTaskId = crypto.randomUUID();
  const parsed = gateResult.parsedTask as { intent?: string; params?: Record<string, unknown>; replyTo?: string; ttl?: string } | undefined;

  // Sender resolution was previously a second Redis hop here; the gate
  // pipeline already calls getAgentByDid during tier resolution, so
  // senderTenantId/senderAgentId now ride along on GateResult.
  if (!parsed?.replyTo && !gateResult.senderAgentId) {
    return res.status(400).json({
      error: 'REPLY_TARGET_UNRESOLVED',
      message: 'Task has no replyTo URL and sender DID is not a registered Nova agent; result would be undeliverable',
    });
  }

  const queuedTask: QueuedTask = {
    taskId: generatedTaskId,
    tenantId: ctx.tenantId,
    agentId: ctx.agentId,
    intent: parsed?.intent || 'unknown_intent',
    params: parsed?.params || {},
    ...(parsed?.replyTo ? { replyTo: parsed.replyTo } : {}),
    ...(gateResult.senderTenantId ? { senderTenantId: gateResult.senderTenantId } : {}),
    ...(gateResult.senderAgentId ? { senderAgentId: gateResult.senderAgentId } : {}),
    senderDid: gateResult.senderDid!,
    tier: gateResult.trustTier!,
    queuedAt: new Date().toISOString(),
    expiresAt: parsed?.ttl ?? new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(),
  };

  try {
    const queued = await enqueueWithIdempotency(ctx, queuedTask, 600);

    if (!queued) {
      logger.info({ taskId: generatedTaskId }, 'Dropped idempotent duplicate request');
    } else {
      const initialState: TaskState = {
        taskId: generatedTaskId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        status: 'submitted',
        intent: queuedTask.intent,
        submittedAt: queuedTask.queuedAt,
        updatedAt: queuedTask.queuedAt,
        expiresAt: queuedTask.expiresAt,
        submitterDid: gateResult.senderDid!,
      };
      await setTaskState(ctx, initialState);

      await auditLog(ctx, {
        event: 'task_queued',
        taskId: generatedTaskId,
        senderDid: gateResult.senderDid,
        tier: gateResult.trustTier,
      });

      logger.info({
        ctx,
        taskId: generatedTaskId,
        senderDid: gateResult.senderDid,
        tier: gateResult.trustTier,
      }, 'Task passed gate pipeline and enqueued');
    }

    const host = req.get('host');
    const baseUrl = `${req.protocol}://${host}/agents/${ctx.agentId}`;

    return res.status(202).json({
      status: 'submitted',
      taskId: generatedTaskId,
      statusUrl: `${baseUrl}/tasks/${generatedTaskId}`,
      streamUrl: `${baseUrl}/tasks/${generatedTaskId}/stream`,
    });

  } catch (err: any) {
    logger.error({ err, taskId: generatedTaskId }, 'Queue failure at ingress');
    return res.status(503).json({ error: 'INTERNAL_ERROR', message: 'Task queue backend temporarily unavailable' });
  }
});
