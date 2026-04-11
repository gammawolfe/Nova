import { Counter } from 'prom-client';
import { createMetricsRegistry } from '@nova/shared/src/metrics';

export const connectorRegistry = createMetricsRegistry('agent-connector');

export const deliveryOutcomes = new Counter({
  name: 'nova_delivery_outcomes_total',
  help: 'Delivery outcomes by target and result',
  labelNames: ['target', 'outcome'] as const,
  registers: [connectorRegistry],
});
