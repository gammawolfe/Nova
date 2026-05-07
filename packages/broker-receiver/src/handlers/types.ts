// packages/broker-receiver/src/handlers/types.ts
//
// Handler contract types only. Extracted from index.ts so individual handlers
// can import their type contract without inheriting a transitive dependency
// on the registry (which imports the handlers themselves to bootstrap them).
//
// Runtime registry, factory plumbing, and built-in handler registration all
// stay in index.ts. This split removes the structural cycle that madge flags
// (handlers/index.ts ↔ handlers/echo.ts and handlers/claude-api.ts) without
// changing the public surface — index.ts re-exports everything here so
// existing callers don't break.

import type { QueuedTask } from '@nova/shared/src/types';

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
