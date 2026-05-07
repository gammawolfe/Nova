// packages/shared/src/error-middleware.ts
//
// Express error handler shared between admin-api and a2a-server.
//
// Supports two response shapes via the `shape` option:
//
//   shape: 'detailed' (default) — used by a2a-server. Always includes a
//     `message` field; ZodError emits structured `issues`; unhandled errors
//     emit a stable error code 'INTERNAL_ERROR'. This is the shape callers
//     of a2a-server have grown up with since H2.
//
//   shape: 'admin'              — used by admin-api. Preserves the wire
//     format the admin web UI's api.js helper depends on:
//       err.message ← parsed.error
//       err.details ← parsed.details
//     Specifically:
//       - ZodError → { error: 'Validation failed', issues: <raw zod issues> }
//       - NovaError → { error: <code>, message: <msg> }
//       - { status: N, message } → { error: <message> }
//       - unhandled → { error: 'Internal server error' }
//
// Maps NovaError codes to HTTP status via DEFAULT_STATUS_MAP, with caller
// overrides merged on top. Fields not present in the chosen shape are
// omitted; both shapes always honour the status code lookup.
//
// New code should prefer the 'detailed' shape. The 'admin' shape exists
// solely to preserve backward compatibility with the existing admin web
// UI; flipping it to 'detailed' is a breaking change for that UI.

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

export type ErrorMiddlewareShape = 'detailed' | 'admin';

export interface ErrorMiddlewareOptions {
  /**
   * Wire shape for error responses. Defaults to 'detailed' for new callers;
   * admin-api passes 'admin' to preserve the existing UI contract.
   */
  shape?: ErrorMiddlewareShape;
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
  const shape = opts.shape ?? 'detailed';
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
      if (shape === 'admin') {
        res.status(400).json({
          error: 'Validation failed',
          issues: err.issues,
        });
        return;
      }
      res.status(400).json({
        error: 'SCHEMA_INVALID',
        message: 'Validation failed',
        issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    if (err instanceof NovaError) {
      const status = statusMap[err.code] ?? 500;
      const body: Record<string, unknown> = { error: err.code, message: err.message };
      if (shape === 'detailed' && err.retryable) body['retryable'] = true;
      res.status(status).json(body);
      return;
    }

    if (err && typeof err === 'object' && typeof (err as any).status === 'number') {
      const status = (err as any).status as number;
      const message = (err as any).message ?? 'Request failed';
      if (shape === 'admin') {
        // Preserve admin-api's old shape: error == message, no separate field.
        res.status(status).json({ error: message });
        return;
      }
      res.status(status).json({
        error: (err as any).code ?? `HTTP_${status}`,
        message,
      });
      return;
    }

    // Unexpected — log full detail server-side, return generic 500 to client.
    logger.error({ err, path: req.path, method: req.method, tag: logTag }, 'Unhandled HTTP error');
    if (shape === 'admin') {
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  };
}
