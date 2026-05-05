// packages/broker-receiver/src/handlers/index.ts
//
// Handler contract + registry. A handler receives a task and returns a
// TaskResult-ish payload. The dispatcher wraps its return in the final
// broker respond body (status + result or error).
//
// HandlerContext.signal fires when:
//   • the daemon is shutting down, OR
//   • the task's visibility window is about to expire (visibleUntil - 30s).
// Handlers that honor the signal wind down cleanly; handlers that ignore
// it still work but risk being double-dispatched if Nova's reclaim worker
// picks up the task before respond lands.

import type { QueuedTask } from '@nova/shared';
import type { ReceiverConfig } from '../config.js';

export interface HandlerResultOk {
  status: 'ok';
  result: unknown;
}

export interface HandlerResultError {
  status: 'error';
  error: { code: string; message: string; retryable?: boolean };
}

export type HandlerResult = HandlerResultOk | HandlerResultError;

export interface HandlerContext {
  agentId: string;
  signal: AbortSignal;
  logger: Logger;
}

export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface Handler {
  name: string;
  handle(task: QueuedTask, ctx: HandlerContext): Promise<HandlerResult>;
}

export type HandlerFactory = (config: Record<string, unknown>) => Handler | Promise<Handler>;

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
