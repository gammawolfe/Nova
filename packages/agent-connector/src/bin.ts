// packages/agent-connector/src/bin.ts
//
// Deployed entry point. The split from index.ts means the wiring module
// can be imported by tests without booting workers, audit drain, reclaim
// loop, heartbeat, or the health HTTP server.

import { logger } from '@nova/shared/src/logger';
import { start } from './index';

start().catch(err => {
  logger.error({ err }, 'agent-connector failed to start');
  process.exit(1);
});
