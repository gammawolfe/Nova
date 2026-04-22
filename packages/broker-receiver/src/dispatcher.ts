// packages/broker-receiver/src/dispatcher.ts
//
// Wraps the handler in the bits the pull loop doesn't want to know about:
// concurrency limiting, in-flight tracking, visibility-timeout abort
// wiring, and shipping the handler's result back via NovaBrokerClient.
//
// The pull loop calls `dispatch(task, visibleUntil, selfUcanFactory)` for
// every task it pulls. Dispatch is fire-and-forget for concurrency > 1,
// blocking for concurrency == 1 (the default and the recommended
// configuration for v1).

import type { QueuedTask } from '@nova/shared/src/types';
import type { Handler, HandlerContext, Logger } from './handlers/index.js';
import type { NovaBrokerClient } from './nova-client.js';

/** How long before visibleUntil we fire the handler AbortSignal, in ms. */
const ABORT_LEAD_MS = 30_000;

export interface DispatcherOptions {
  agentId: string;
  handler: Handler;
  client: NovaBrokerClient;
  /** Returns a fresh self-UCAN; called once per respond. */
  mintSelfUcan: () => string;
  maxConcurrentTasks: number;
  logger: Logger;
}

export interface DispatcherStats {
  inFlight: number;
  totalDispatched: number;
  totalResponded: number;
  totalHandlerErrors: number;
  totalTransportErrors: number;
}

export class Dispatcher {
  private inFlight = new Map<string, { abort: AbortController; timer: NodeJS.Timeout }>();
  private stats = {
    totalDispatched: 0,
    totalResponded: 0,
    totalHandlerErrors: 0,
    totalTransportErrors: 0,
  };
  private shuttingDown = false;
  private shutdownAbort = new AbortController();

  constructor(private readonly opts: DispatcherOptions) {}

  get currentInFlight(): number {
    return this.inFlight.size;
  }

  get isFull(): boolean {
    return this.inFlight.size >= this.opts.maxConcurrentTasks;
  }

  getStats(): DispatcherStats {
    return { ...this.stats, inFlight: this.inFlight.size };
  }

  /**
   * Run one task through the handler and respond. Returns a promise that
   * resolves once the respond call has completed (or failed). Safe to
   * await sequentially in the pull loop (concurrency == 1) or to
   * fire-and-forget up to maxConcurrentTasks in parallel.
   */
  async dispatch(task: QueuedTask, visibleUntilIso: string): Promise<void> {
    if (this.shuttingDown) {
      this.opts.logger.warn({ taskId: task.taskId }, 'dispatch rejected: shutting down');
      return;
    }
    if (this.isFull) {
      // Shouldn't happen if the pull loop checks isFull before pulling, but
      // defend against it anyway.
      throw new Error(`dispatcher full (${this.inFlight.size}/${this.opts.maxConcurrentTasks})`);
    }
    this.stats.totalDispatched += 1;

    const abort = new AbortController();
    const visibleUntilMs = new Date(visibleUntilIso).getTime();
    const leadUntilFire = Math.max(0, visibleUntilMs - Date.now() - ABORT_LEAD_MS);
    const timer = setTimeout(() => {
      this.opts.logger.warn(
        { taskId: task.taskId, visibleUntil: visibleUntilIso },
        'approaching visibility timeout; aborting handler',
      );
      abort.abort();
    }, leadUntilFire);

    this.inFlight.set(task.taskId, { abort, timer });

    // Handler signal fires on either: task-specific lead timer OR daemon shutdown.
    const combinedSignal = mergeAbortSignals([abort.signal, this.shutdownAbort.signal]);

    const ctx: HandlerContext = {
      agentId: this.opts.agentId,
      signal: combinedSignal,
      logger: this.opts.logger,
    };

    try {
      let result;
      try {
        result = await this.opts.handler.handle(task, ctx);
      } catch (err: any) {
        this.stats.totalHandlerErrors += 1;
        this.opts.logger.error(
          { err: err.message, taskId: task.taskId, handler: this.opts.handler.name },
          'handler threw',
        );
        result = {
          status: 'error' as const,
          error: {
            code: 'HANDLER_EXCEPTION',
            message: err.message ?? String(err),
            retryable: false,
          },
        };
      }

      // The handler may have run past visibleUntil. Respond anyway — Nova
      // returns task_not_found / already_completed if the task was
      // reclaimed, and we log but don't retry.
      try {
        const outcome = await this.opts.client.respond(
          this.opts.agentId,
          this.opts.mintSelfUcan(),
          task.taskId,
          result,
        );
        this.stats.totalResponded += 1;
        this.opts.logger.info(
          {
            taskId: task.taskId,
            outcome,
            handlerStatus: result.status,
          },
          'responded',
        );
      } catch (err: any) {
        this.stats.totalTransportErrors += 1;
        this.opts.logger.error(
          { err: err.message, taskId: task.taskId },
          'respond failed; task will be reclaimed by Nova',
        );
      }
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(task.taskId);
    }
  }

  /**
   * Signal shutdown and wait (up to graceSeconds) for in-flight handlers
   * to finish. Any tasks still in flight when the grace expires are left
   * alone — Nova's reclaim worker will redeliver them.
   */
  async shutdown(graceSeconds: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownAbort.abort();

    const deadline = Date.now() + graceSeconds * 1_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    for (const { timer } of this.inFlight.values()) {
      clearTimeout(timer);
    }
  }
}

function mergeAbortSignals(signals: AbortSignal[]): AbortSignal {
  // AbortSignal.any exists in Node 20+ and browser; use it when available
  // and fall back to a hand-rolled combiner otherwise.
  const any = (AbortSignal as any).any as undefined | ((s: AbortSignal[]) => AbortSignal);
  if (typeof any === 'function') return any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      return controller.signal;
    }
    s.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
