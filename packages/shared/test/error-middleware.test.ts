// packages/shared/test/error-middleware.test.ts
//
// Verifies the shared error handler used by a2a-server (and adoptable by
// admin-api). The handler is deliberately format-stable: existing clients
// rely on the { error, message, ... } shape, so the tests pin every
// branch to a concrete response.

import { describe, it, expect, vi } from 'vitest';
import { ZodError } from 'zod';
import { z } from 'zod';
import { createErrorMiddleware } from '../src/error-middleware';
import { NovaError } from '../src/errors';

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const REQ: any = { path: '/test', method: 'POST' };
const NEXT: any = vi.fn();

describe('createErrorMiddleware', () => {
  it('maps ZodError → 400 with structured issues', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    const schema = z.object({ x: z.string() });
    const parsed = schema.safeParse({ x: 1 });
    if (parsed.success) throw new Error('expected validation failure');
    handler(parsed.error, REQ, res, NEXT);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe('SCHEMA_INVALID');
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toEqual({ path: 'x', message: expect.any(String) });
  });

  it('maps NovaError(UCAN_MISSING) → 401', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    handler(new NovaError('UCAN_MISSING', 'no token'), REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'UCAN_MISSING', message: 'no token' });
  });

  it('maps NovaError(SCHEMA_INVALID) → 400', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    handler(new NovaError('SCHEMA_INVALID', 'bad schema'), REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('maps NovaError(RATE_LIMITED) → 429', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    handler(new NovaError('RATE_LIMITED', 'slow down'), REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('uses 500 for unknown NovaError codes', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    handler(new NovaError('UNMAPPED_FUTURE_CODE', 'wat'), REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('honours statusOverrides for service-specific mappings', () => {
    const handler = createErrorMiddleware({
      statusOverrides: { CUSTOM_CODE: 418 },
    });
    const res = makeRes();
    handler(new NovaError('CUSTOM_CODE', 'teapot'), REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(418);
  });

  it('emits retryable: true when NovaError is retryable', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    handler(new NovaError('CLASSIFIER_UNAVAILABLE', 'down', true), REQ, res, NEXT);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'CLASSIFIER_UNAVAILABLE', retryable: true }),
    );
  });

  it('handles entity.too.large → 413 PAYLOAD_TOO_LARGE', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    const err: any = new Error('too large');
    err.type = 'entity.too.large';
    err.limit = 65536;
    handler(err, REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'PAYLOAD_TOO_LARGE' }),
    );
  });

  it('passes through {status, message} shape', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    const err: any = new Error('not found');
    err.status = 404;
    err.code = 'AGENT_NOT_FOUND';
    handler(err, REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'AGENT_NOT_FOUND', message: 'not found' });
  });

  it('falls back to generic 500 for unknown errors', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    handler(new Error('mystery'), REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe('INTERNAL_ERROR');
    // Generic — never leak Error.message or stack for unmapped errors.
    expect(body.message).toBe('Internal server error');
  });

  it('next is unused (handler is a terminal middleware)', () => {
    const handler = createErrorMiddleware();
    const res = makeRes();
    const localNext = vi.fn();
    handler(new Error('x'), REQ, res, localNext);
    expect(localNext).not.toHaveBeenCalled();
  });
});

// ── shape: 'admin' ──────────────────────────────────────────────────────────
//
// admin-api's web UI parses errors as:
//   err.message ← parsed.error
//   err.details ← parsed.details
// so the wire shape MUST keep `error` populated with a human-readable
// string, not a code. These tests pin every branch of shape:'admin' to
// the exact response the UI's api.js depends on.

describe('createErrorMiddleware — shape: admin', () => {
  it('ZodError → { error: "Validation failed", issues: <raw zod issues> }', () => {
    const handler = createErrorMiddleware({ shape: 'admin' });
    const res = makeRes();
    const schema = z.object({ x: z.string() });
    const parsed = schema.safeParse({ x: 1 });
    if (parsed.success) throw new Error('expected validation failure');
    handler(parsed.error, REQ, res, NEXT);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe('Validation failed');
    expect(body.issues).toBe(parsed.error.issues); // raw, not transformed
    // No `message` field in admin shape for ZodError.
    expect(body.message).toBeUndefined();
  });

  it('NovaError → { error: <code>, message: <msg> } at mapped status', () => {
    const handler = createErrorMiddleware({ shape: 'admin' });
    const res = makeRes();
    handler(new NovaError('UCAN_MISSING', 'no token'), REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'UCAN_MISSING', message: 'no token' });
  });

  it('NovaError(retryable) does NOT include `retryable` in admin shape', () => {
    const handler = createErrorMiddleware({ shape: 'admin' });
    const res = makeRes();
    handler(new NovaError('CLASSIFIER_UNAVAILABLE', 'down', true), REQ, res, NEXT);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe('CLASSIFIER_UNAVAILABLE');
    expect(body.message).toBe('down');
    // The admin UI doesn't expose retryability — keep it out of the wire.
    expect(body.retryable).toBeUndefined();
  });

  it('{status, message} → { error: <message> } only', () => {
    const handler = createErrorMiddleware({ shape: 'admin' });
    const res = makeRes();
    const err: any = new Error('agent not found');
    err.status = 404;
    handler(err, REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(404);
    // Critically: admin UI's api.js sets err.message ← parsed.error, so
    // `error` MUST be the human-readable message in this shape.
    expect(res.json).toHaveBeenCalledWith({ error: 'agent not found' });
  });

  it('unhandled → 500 { error: "Internal server error" }', () => {
    const handler = createErrorMiddleware({ shape: 'admin' });
    const res = makeRes();
    handler(new Error('mystery'), REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  it('entity.too.large → 413 (same shape across both modes)', () => {
    const handler = createErrorMiddleware({ shape: 'admin' });
    const res = makeRes();
    const err: any = new Error('too large');
    err.type = 'entity.too.large';
    err.limit = 65536;
    handler(err, REQ, res, NEXT);
    expect(res.status).toHaveBeenCalledWith(413);
    // PAYLOAD_TOO_LARGE is intentionally identical in both shapes — the
    // admin UI doesn't have special handling for body-size errors and a
    // structured response is always more useful than express's default.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'PAYLOAD_TOO_LARGE' }),
    );
  });

  it('default shape stays "detailed" when option omitted', () => {
    const handler = createErrorMiddleware({});
    const res = makeRes();
    handler(new Error('mystery'), REQ, res, NEXT);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe('INTERNAL_ERROR'); // detailed shape, not admin
  });
});
