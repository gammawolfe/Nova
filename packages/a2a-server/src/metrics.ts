import { Gauge } from 'prom-client';
import { createMetricsRegistry } from '@nova/shared/src/metrics';

export const a2aRegistry = createMetricsRegistry('a2a-server');

export const activeSseStreams = new Gauge({
  name: 'nova_active_sse_streams',
  help: 'Number of active SSE stream connections',
  registers: [a2aRegistry],
});
