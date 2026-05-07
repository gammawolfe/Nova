// packages/broker-receiver/src/handlers/index.ts
//
// Handler registry + built-in registration. The contract types live in
// ./types so individual handlers can declare their interface without
// importing from this file (which would create a runtime-irrelevant but
// structurally-circular dependency).
//
// HandlerContext.signal fires when:
//   • the daemon is shutting down, OR
//   • the task's visibility window is about to expire (visibleUntil - 30s).
// Handlers that honor the signal wind down cleanly; handlers that ignore
// it still work but risk being double-dispatched if Nova's reclaim worker
// picks up the task before respond lands.

import type { ReceiverConfig } from '../config.js';
import type { Handler, HandlerFactory } from './types.js';

// Re-export the contract surface so existing imports of this module keep
// working unchanged.
export type {
  Handler, HandlerFactory, HandlerResult, HandlerResultOk, HandlerResultError,
  HandlerContext, Logger,
} from './types.js';

const registry = new Map<string, HandlerFactory>();

export function registerHandler(name: string, factory: HandlerFactory): void {
  registry.set(name, factory);
}

export async function createHandler(cfg: ReceiverConfig): Promise<Handler> {
  const factory = registry.get(cfg.handler);
  if (!factory) {
    throw new Error(`Unknown handler '${cfg.handler}'. Known: ${[...registry.keys()].join(', ')}`);
  }
  return factory(cfg.handlerConfig);
}

// Built-in handlers register on import. Callers that want a trimmed set
// can import from the specific handler module instead of this index.
import { echoHandlerFactory } from './echo.js';
import { claudeApiHandlerFactory } from './claude-api.js';

registerHandler('echo', echoHandlerFactory);
registerHandler('claude-api', claudeApiHandlerFactory);
