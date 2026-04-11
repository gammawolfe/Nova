import { RequestHandler } from 'express';

export interface HealthCheck {
  status: 'ok' | 'fail';
  latencyMs?: number;
  message?: string;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  uptime: number;
  checks: Record<string, HealthCheck>;
}

/**
 * Returns the worst status from a set of health checks.
 */
export function aggregateHealth(checks: Record<string, HealthCheck>): HealthResponse['status'] {
  const statuses = Object.values(checks).map(c => c.status);
  if (statuses.every(s => s === 'ok')) return 'ok';
  if (statuses.every(s => s === 'fail')) return 'down';
  return 'degraded';
}

/**
 * Wraps an async probe with timing and error handling.
 */
export async function timedCheck(fn: () => Promise<void>): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await fn();
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err: any) {
    return { status: 'fail', latencyMs: Date.now() - start, message: err.message };
  }
}

/**
 * Express handler factory that builds a /health endpoint for a service.
 */
export function healthHandler(
  serviceName: string,
  startTime: number,
  getChecks: () => Promise<Record<string, HealthCheck>>
): RequestHandler {
  return (_req, res) => {
    getChecks().then(checks => {
      const status = aggregateHealth(checks);
      const response: HealthResponse = {
        status,
        service: serviceName,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        checks,
      };
      res.status(status === 'down' ? 503 : 200).json(response);
    }).catch(() => {
      res.status(503).json({ status: 'down', service: serviceName });
    });
  };
}
