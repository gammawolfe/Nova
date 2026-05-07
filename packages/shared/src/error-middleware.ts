// packages/shared/src/error-middleware.ts
//
// Express error handler shared between admin-api and a2a-server.
//
// Maps:
//   • ZodError                → 400 with structured issues
//   • NovaError               → status from a code-to-status map; falls back to 500
//   • err.status (numeric)    → that status, with err.message as the body
//   • Anything else           → 500 'Internal server error', stack logged but not returned
//
// The same shape was previously inlined in admin-api/src/middleware/error-handler.ts;
// extracting here so a2a-server's H2 hardening pass can adopt it without
// duplicating the body. admin-api can switch to this helper in a follow-up
// PR — the public response shape is identical to the existing handler so
// such a swap is a no-op for clients.

import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { NovaError } from './errors';
import { logger } from './logger';

const DEFAULT_STATUS_MAP: Record<string, number> = {
  // Auth & cap
  UCAN_MISSING: 401,
  UCAN_INVALID_JWT: 401,
  UCAN_EXPIRED: 401,
  UCAN_REVOKED: 401,
  UCAN_DID_MISMATCH: 401,
  UCAN_WRONG_AUDIENCE: 401,
  UCAN_INSUFFICIENT_CAPABILITY: 403,
  // Discovery
  ACTOR_UNKNOWN: 404,
  // Validation
  SCHEMA_INVALID: 400,
  SCHEMA_VERSION_UNSUPPORTED: 400,
  INTENT_UNKNOWN: 400,
  INTENT_NOT_IN_ACTOR_ALLOWLIST: 403,
  PROTOCOL_VERSION_UNSUPPORTED: 400,
  // Body / TTL
  TASK_TTL_EXPIRED_AT_INGRESS: 410,
  // Throttling
  RATE_LIMITED: 429,
  // Injection
  INJECTION_PATTERN_MATCH: 422,
  INJECTION_DETECTED: 422,
  INJECTION_SUSPECTED: 422,
  CLASSIFIER_UNAVAILABLE: 503,
};

export interface ErrorMiddlewareOptions {
  /**
   * Override status code for specific NovaError codes. Merged on top of
   * DEFAULT_STATUS_MAP so callers can extend rather than replace.
   */
  statusOverrides?: Record<string, number>;
  /**
   * Tag emitted in structured logs for unhandled errors. Defaults to
   * 'unhandled-http-error'; admin-api and a2a-server pass their own so
   * the dashboard can split traffic.
   */
  logTag?: string;
}

export function createErrorMiddleware(opts: ErrorMiddlewareOptions = {}): ErrorRequestHandler {
  const statusMap = { ...DEFAULT_STATUS_MAP, ...(opts.statusOverrides ?? {}) };
  const logTag = opts.logTag ?? 'unhandled-http-error';

  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    // Body-parser size violation. Express 4.x raises this with a numeric
    // `status` of 413 already, but the structured response is friendlier.
    if (err && typeof err === 'object' && (err as any).type === 'entity.too.large') {
      res.status(413).json({
        error: 'PAYLOAD_TOO_LARGE',
        message: `Request body exceeds limit (${(err as any).limit} bytes)`,
      });
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'SCHEMA_INVALID',
        message: 'Validation failed',
        issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    if (err instanceof NovaError) {
      const status = statusMap[err.code] ?? 500;
      res.status(status).json({
        error: err.code,
        message: err.message,
        ...(err.retryable ? { retryable: true } : {}),
      });
      return;
    }

    if (err && typeof err === 'object' && typeof (err as any).status === 'number') {
      const status = (err as any).status as number;
      res.status(status).json({
        error: (err as any).code ?? `HTTP_${status}`,
        message: (err as any).message ?? 'Request failed',
      });
      return;
    }

    // Unexpected — log full detail server-side, return generic 500 to client.
    logger.error({ err, path: req.path, method: req.method, tag: logTag }, 'Unhandled HTTP error');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  };
}
