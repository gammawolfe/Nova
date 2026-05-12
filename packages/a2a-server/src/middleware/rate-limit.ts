// packages/a2a-server/src/middleware/rate-limit.ts
//
// Per-sender-IP + global-per-agent rate limiter, originally inline in
// index.ts's POST /tasks handler. Both counters use Redis INCR with a
// 60s EXPIRE window so the limit survives across multiple a2a-server
// instances behind a load balancer.
//
// Failure mode: if Redis is unavailable, we return 503 — the rate-limit
// check is a load-shedding mechanism for the gate pipeline behind it,
// and the spec calls for 503 on backend unavailability so callers can
// retry with backoff rather than treating it as a permanent error.
//
// The middleware is constructed via a factory so call sites can override
// the per-sender / global ceilings (currently identical defaults for
// every mount, but the factory lets us tune them per-route without
// reaching back into process.env).

import type { Request, Response, NextFunction } from 'express';
import { logger } from '@nova/shared/src/logger';
import { redisKey } from '@nova/shared/src/tenant';
import { getSharedRedis } from '@nova/shared/src/redis';

export interface RateLimitOptions {
  /** Bucket size per remote IP per 60s window. */
  perSender: number;
  /** Bucket size per (tenant, agent) across all IPs per 60s window. */
  global: number;
}

const RATE_WINDOW_SECONDS = 60;

export function createRateLimitMiddleware(opts: RateLimitOptions) {
  return async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const ctx = req.ctx;
    const senderIp = req.ip ?? '0.0.0.0';

    try {
      const senderKey = redisKey(ctx, 'rate', 'sender', senderIp);
      const globalKey = redisKey(ctx, 'rate', 'global');

      // Pipeline so the four commands ride a single round-trip rather
      // than four sequential RTTs on the hot ingress path.
      const pipe = getSharedRedis().pipeline();
      pipe.incr(senderKey);
      pipe.expire(senderKey, RATE_WINDOW_SECONDS);
      pipe.incr(globalKey);
      pipe.expire(globalKey, RATE_WINDOW_SECONDS);
      const results = await pipe.exec();

      const senderCount = (results?.[0]?.[1] as number) ?? 0;
      const globalCount = (results?.[2]?.[1] as number) ?? 0;

      if (senderCount > opts.perSender || globalCount > opts.global) {
        res.setHeader('Retry-After', String(RATE_WINDOW_SECONDS));
        res.status(429).json({ error: 'RATE_LIMITED' });
        return;
      }

      next();
    } catch (err) {
      logger.error({ err }, 'Redis unavailable during rate limit check');
      res.status(503).json({
        error: 'INTERNAL_ERROR',
        message: 'Service temporarily unavailable',
      });
    }
  };
}
