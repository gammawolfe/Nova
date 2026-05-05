// packages/broker-receiver/src/handlers/echo.ts
//
// Deterministic test handler. Used by the acceptance test to exercise the
// full pull → dispatch → respond loop without a real AI in the middle.
// Also handy for integration debugging — if a real handler misbehaves,
// swapping the handler to 'echo' isolates whether the problem is in the
// daemon's machinery or in the handler itself.

import type { Handler, HandlerFactory, HandlerResult } from './index.js';
import type { QueuedTask } from '@nova/shared';

export const echoHandlerFactory: HandlerFactory = () => {
  const handler: Handler = {
    name: 'echo',
    async handle(task: QueuedTask): Promise<HandlerResult> {
      return {
        status: 'ok',
        result: {
          echoed: true,
          intent: task.intent,
          params: task.params,
          handledAt: new Date().toISOString(),
        },
      };
    },
  };
  return handler;
};
