import { Counter } from 'prom-client';
import { createMetricsRegistry } from '@nova/shared/src/metrics';

export const connectorRegistry = createMetricsRegistry('agent-connector');

export const deliveryOutcomes = new Counter({
  name: 'nova_delivery_outcomes_total',
  help: 'Delivery outcomes by target and result',
  labelNames: ['target', 'outcome'] as const,
  registers: [connectorRegistry],
});

export const confirmRequeues = new Counter({
  name: 'nova_confirm_requeue_total',
  help: 'Confirmation re-queue cycles (delayed re-check)',
  labelNames: ['intent', 'tenant_id', 'agent_id'] as const,
  registers: [connectorRegistry],
});
