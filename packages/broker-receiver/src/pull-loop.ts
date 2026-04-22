// packages/broker-receiver/src/pull-loop.ts
//
// The heart of the daemon. Long-polls the broker inbox, routes each task
// through the Dispatcher, and backs off on transport errors. Owns no
// state beyond loop counters — the Dispatcher owns in-flight tasks, the
// NovaBrokerClient owns the HTTP call.
//
// Lifecycle:
//   start() — begins looping (non-blocking). Safe to call once.
//   stop()  — breaks the loop at the next safe point, then resolves the
//             promise returned by run() after the loop has exited. Does
//             NOT drain dispatched handlers; callers drain the Dispatcher
//             separately so pull-loop teardown and handler drain have
//             distinct budgets.

import type { Dispatcher } from './dispatcher.js';
import type { NovaBrokerClient } from './nova-client.js';
import { TransportError, HttpError } from './nova-client.js';
import type { Logger } from './handlers/index.js';

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export interface PullLoopOptions {
  agentId: string;
  client: NovaBrokerClient;
  dispatcher: Dispatcher;
  mintSelfUcan: () => string;
  pollWaitMs: number;
  logger: Logger;
}

export interface PullLoopStats {
  running: boolean;
  totalPulls: number;
  totalTasks: number;
  totalPullErrors: number;
  consecutiveErrors: number;
  lastTaskAt?: string | undefined;
  lastErrorAt?: string | undefined;
}

export class PullLoop {
  private running = false;
  private stopping = false;
  private stopSignal = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private consecutiveErrors = 0;

  private totalPulls = 0;
  private totalTasks = 0;
  private totalPullErrors = 0;
  private lastTaskAt: string | undefined;
  private lastErrorAt: string | undefined;

  constructor(private readonly opts: PullLoopOptions) {}

  getStats(): PullLoopStats {
    return {
      running: this.running,
      totalPulls: this.totalPulls,
      totalTasks: this.totalTasks,
      totalPullErrors: this.totalPullErrors,
      consecutiveErrors: this.consecutiveErrors,
      lastTaskAt: this.lastTaskAt,
      lastErrorAt: this.lastErrorAt,
    };
  }

  /** Start the loop. Non-blocking; returns a promise that resolves when the loop exits. */
  start(): Promise<void> {
    if (this.running) return this.loopPromise ?? Promise.resolve();
    this.running = true;
    this.stopping = false;
    this.loopPromise = this.run();
    return this.loopPromise;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.stopSignal.abort();
    if (this.loopPromise) await this.loopPromise;
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopping) {
        if (this.opts.dispatcher.isFull) {
          // Concurrency ceiling hit; wait for a slot before pulling more.
          await this.sleep(50);
          continue;
        }

        try {
          this.totalPulls += 1;
          const result = await this.opts.client.pull(
            this.opts.agentId,
            this.opts.mintSelfUcan(),
            this.opts.pollWaitMs,
            this.stopSignal.signal,
          );
          this.consecutiveErrors = 0;

          if (!result) continue; // 204 — empty window, loop back

          this.totalTasks += 1;
          this.lastTaskAt = new Date().toISOString();
          this.opts.logger.info(
            { taskId: result.task.taskId, intent: result.task.intent },
            'task pulled',
          );

          // Fire-and-forget dispatch so the loop can pull the next task.
          // The Dispatcher enforces the concurrency ceiling via isFull.
          void this.opts.dispatcher
            .dispatch(result.task, result.visibleUntil)
            .catch(err => {
              this.opts.logger.error(
                { err: err.message, taskId: result.task.taskId },
                'dispatch rejected unexpectedly',
              );
            });
        } catch (err: any) {
          // Aborted mid-pull during shutdown — exit cleanly.
          if (this.stopping) break;

          this.totalPullErrors += 1;
          this.consecutiveErrors += 1;
          this.lastErrorAt = new Date().toISOString();

          if (err instanceof TransportError) {
            const delay = this.nextBackoff();
            this.opts.logger.warn(
              { err: err.message, delay, consecutiveErrors: this.consecutiveErrors },
              'pull transport error; backing off',
            );
            await this.sleep(delay);
          } else if (err instanceof HttpError) {
            // 4xx = misconfig / auth; 5xx = server-side transient. Back
            // off on both. If the operator's self-UCAN is permanently
            // bad, the loop will keep retrying at the cap, surfacing in
            // logs and /health until fixed.
            const delay = this.nextBackoff();
            this.opts.logger.warn(
              { status: err.status, body: err.body, delay, consecutiveErrors: this.consecutiveErrors },
              'pull http error; backing off',
            );
            await this.sleep(delay);
          } else {
            const delay = this.nextBackoff();
            this.opts.logger.error(
              { err: err.message, delay, consecutiveErrors: this.consecutiveErrors },
              'pull unexpected error; backing off',
            );
            await this.sleep(delay);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private nextBackoff(): number {
    const n = Math.min(this.consecutiveErrors, 10);
    return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.stopSignal.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.stopSignal.signal.aborted) return onAbort();
      this.stopSignal.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
