import { Registry, collectDefaultMetrics } from 'prom-client';
import { RequestHandler } from 'express';

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
 * Express handler that serves metrics in Prometheus exposition format.
 */
export function metricsHandler(registry: Registry): RequestHandler {
  return (_req, res) => {
    registry.metrics().then(metrics => {
      res.set('Content-Type', registry.contentType);
      res.end(metrics);
    }).catch(() => {
      res.status(500).end('Error collecting metrics');
    });
  };
}
