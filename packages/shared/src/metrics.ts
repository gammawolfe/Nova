import { Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Creates a Prometheus metrics registry with default process metrics.
 * Each service gets its own registry (standard for multi-container setups).
 */
export function createMetricsRegistry(serviceName: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });
  return registry;
}

/**
 * Cross-version Express handler shape. The repo mixes @types/express ^4
 * (a2a-server, admin-api) and ^5 (agent-connector, gate-service), and the
 * two declare incompatible `RequestHandler` types. Returning a structural
 * callable from metricsHandler lets every caller mount it with
 * `app.get('/metrics', metricsHandler(reg))` — no `as any` cast — until
 * the workspace finishes its v4→v5 migration.
 */
export type MetricsHandler = (req: unknown, res: any, next?: () => void) => void;

/**
 * Express handler that serves metrics in Prometheus exposition format.
 */
export function metricsHandler(registry: Registry): MetricsHandler {
  return (_req, res) => {
    registry.metrics().then(metrics => {
      res.set('Content-Type', registry.contentType);
      res.end(metrics);
    }).catch(() => {
      res.status(500).end('Error collecting metrics');
    });
  };
}
