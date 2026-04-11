import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { NovaError } from '@nova/shared/src/errors';
import { logger } from '@nova/shared/src/logger';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', issues: err.issues });
    return;
  }

  if (err instanceof NovaError) {
    const statusMap: Record<string, number> = {
      UCAN_MISSING: 401, UCAN_INVALID_JWT: 401, UCAN_EXPIRED: 401,
      SCHEMA_INVALID: 400, INTENT_UNKNOWN: 400,
      ACTOR_UNKNOWN: 404,
    };
    const status = statusMap[err.code] ?? 500;
    res.status(status).json({ error: err.code, message: err.message });
    return;
  }

  if (typeof (err as any).status === 'number') {
    res.status((err as any).status).json({ error: err.message });
    return;
  }

  logger.error({ err }, 'Unhandled admin API error');
  res.status(500).json({ error: 'Internal server error' });
};
