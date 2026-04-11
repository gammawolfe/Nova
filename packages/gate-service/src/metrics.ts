import { Counter, Histogram, Gauge } from 'prom-client';
import { createMetricsRegistry } from '@nova/shared/src/metrics';

export const gateRegistry = createMetricsRegistry('gate-service');

export const gateDecisions = new Counter({
  name: 'nova_gate_decisions_total',
  help: 'Total gate decisions by outcome',
  labelNames: ['decision', 'error_code'] as const,
  registers: [gateRegistry],
});

export const gateLatency = new Histogram({
  name: 'nova_gate_latency_ms',
  help: 'Gate pipeline latency in milliseconds',
  buckets: [10, 50, 100, 250, 500, 1000, 2500],
  registers: [gateRegistry],
});

export const classifierResults = new Counter({
  name: 'nova_classifier_results_total',
  help: 'Classifier decisions by result and stage',
  labelNames: ['result', 'stage'] as const,
  registers: [gateRegistry],
});

export const classifierCacheHits = new Counter({
  name: 'nova_classifier_cache_hits_total',
  help: 'Classifier cache hits',
  registers: [gateRegistry],
});

export const classifierCacheMisses = new Counter({
  name: 'nova_classifier_cache_misses_total',
  help: 'Classifier cache misses',
  registers: [gateRegistry],
});

export const quarantineDepth = new Gauge({
  name: 'nova_quarantine_depth',
  help: 'Current quarantine entry count',
  labelNames: ['tenant_id', 'agent_id'] as const,
  registers: [gateRegistry],
});
