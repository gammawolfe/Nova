// packages/broker-receiver/src/index.ts
//
// Library entry — re-exports the pieces other packages or tests might
// consume. The operator entry is cli.ts (bin: broker-receiver).

export { resolveConfig, ReceiverConfigSchema } from './config.js';
export type { ReceiverConfig } from './config.js';
export { runDaemon } from './run.js';
export type { RunResult } from './run.js';
export { NovaBrokerClient, TransportError, HttpError } from './nova-client.js';
export type { PullResult, RespondBody, RespondOutcome } from './nova-client.js';
export { Dispatcher } from './dispatcher.js';
export { PullLoop } from './pull-loop.js';
export { HealthServer } from './health-server.js';
export type { HealthSnapshot } from './health-server.js';
export type { Handler, HandlerContext, HandlerFactory, HandlerResult, Logger } from './handlers/index.js';
export { registerHandler, createHandler } from './handlers/index.js';
export { createLogger } from './logger.js';
