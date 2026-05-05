import { Gauge, Histogram } from 'prom-client';
import { createMetricsRegistry } from '@nova/shared';

export const queueRegistry = createMetricsRegistry('task-queue');

export const queueDepth = new Gauge({
  name: 'nova_queue_depth',
  help: 'Current task queue depth',
  labelNames: ['tier'] as const,
  registers: [queueRegistry],
});

export const taskDuration = new Histogram({
  name: 'nova_task_duration_ms',
  help: 'Task processing duration in milliseconds',
  labelNames: ['intent', 'status'] as const,
  buckets: [100, 500, 1000, 5000, 15000, 30000, 60000],
  registers: [queueRegistry],
});
