// packages/broker-receiver/src/claim-loop.ts
//
// Replaces the long-poll PullLoop from p3.2. The daemon now learns of new
// inbox arrivals from two independent triggers:
//
//   • SSE subscription to /agents/:id/inbox/stream (fires on every enqueue,
//     ~100ms end-to-end). Only active when inboxStrategy === 'push'.
//   • Fallback tick every pollFallbackMs (default 30s). Always active.
//
// Each trigger sets a shared `claimPending` flag. A worker observes the
// flag and calls client.pull(1_000) — a short claim with no blocking — in
// a loop until it returns 204 or the dispatcher fills up. One pull cycle
// drains arbitrarily many notifications, so a burst of 50 enqueues still
// only costs one fresh pull per drain iteration.
//
// Invariants preserved from the long-poll implementation:
//   • Notification ≠ claim. The claim is still BLPOP via /inbox; SSE is
//     only a wake signal. First caller wins; losers get 204 in under 1s.
//   • Dispatcher concurrency ceiling: the worker parks when isFull and
//     resumes when a slot frees, so tasks never exceed maxConcurrentTasks.
//   • Graceful shutdown: stop() aborts the SSE subscription, stops the
//     tick, and drains whatever's in the worker. In-flight handler tasks
//     are the dispatcher's concern.
//
// The public surface (start/stop/getStats) is kept compatible with the
// prior PullLoop so run.ts only needs a minor wiring update.

import { streamSseEvents, SseStreamHandle } from '@nova/shared/src/sse-client';
import type { Dispatcher } from './dispatcher.js';
import type { NovaBrokerClient } from './nova-client.js';
import { TransportError, HttpError } from './nova-client.js';
import type { Logger } from './handlers/index.js';

const CLAIM_WAIT_MS = 1_000;
const ERROR_BACKOFF_BASE_MS = 1_000;
const ERROR_BACKOFF_CAP_MS = 60_000;

export interface ClaimLoopOptions {
  agentId: string;
  client: NovaBrokerClient;
  dispatcher: Dispatcher;
  mintSelfUcan: () => string;
  novaUrl: string;
  inboxStrategy: 'push' | 'poll';
  pollFallbackMs: number;
  logger: Logger;
}

export interface ClaimLoopStats {
  running: boolean;
  totalPulls: number;
  totalTasks: number;
  totalPullErrors: number;
  consecutiveErrors: number;
  lastTaskAt?: string | undefined;
  lastErrorAt?: string | undefined;
  triggers: {
    fromSse: number;
    fromTick: number;
  };
  sse: {
    enabled: boolean;
    connected: boolean;
    reconnectCount: number;
    eventsReceived: number;
    lastEventId: number;
    lastEventAt?: string | undefined;
  };
}

export class ClaimLoop {
  private running = false;
  private stopping = false;
  private stopSignal = new AbortController();
  private workerPromise: Promise<void> | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private sseHandle: SseStreamHandle | null = null;
  private sseAbort: AbortController | null = null;

  private claimPending = false;
  private wakeWorker: (() => void) | null = null;
  private consecutiveErrors = 0;

  private totalPulls = 0;
  private totalTasks = 0;
  private totalPullErrors = 0;
  private fromSse = 0;
  private fromTick = 0;
  private lastTaskAt: string | undefined;
  private lastErrorAt: string | undefined;

  constructor(private readonly opts: ClaimLoopOptions) {}

  getStats(): ClaimLoopStats {
    const sseStats = this.sseHandle?.stats();
    return {
      running: this.running,
      totalPulls: this.totalPulls,
      totalTasks: this.totalTasks,
      totalPullErrors: this.totalPullErrors,
      consecutiveErrors: this.consecutiveErrors,
      lastTaskAt: this.lastTaskAt,
      lastErrorAt: this.lastErrorAt,
      triggers: { fromSse: this.fromSse, fromTick: this.fromTick },
      sse: {
        enabled: this.opts.inboxStrategy === 'push',
        connected: sseStats?.connected ?? false,
        reconnectCount: sseStats?.reconnectCount ?? 0,
        eventsReceived: sseStats?.eventsReceived ?? 0,
        lastEventId: sseStats?.lastEventId ?? 0,
        lastEventAt: sseStats?.lastEventAt,
      },
    };
  }

  start(): Promise<void> {
    if (this.running) return this.workerPromise ?? Promise.resolve();
    this.running = true;
    this.stopping = false;

    // Kick the worker once at startup to drain anything already queued.
    this.trigger('tick');

    this.tickTimer = setInterval(() => this.trigger('tick'), this.opts.pollFallbackMs);
    // setInterval keeps the event loop alive; let Node exit in dev if the
    // only thing pinning it is our tick.
    this.tickTimer.unref?.();

    if (this.opts.inboxStrategy === 'push') {
      this.startSseSubscription();
    }

    this.workerPromise = this.runWorker();
    return this.workerPromise;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.stopSignal.abort();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.sseAbort) {
      this.sseAbort.abort();
    }
    // Wake the worker in case it's parked waiting for a trigger.
    this.wakeWorker?.();
    if (this.workerPromise) await this.workerPromise;
    if (this.sseHandle) {
      try { await this.sseHandle.done; } catch { /* ignore */ }
    }
  }

  private trigger(source: 'sse' | 'tick'): void {
    if (source === 'sse') this.fromSse += 1;
    else this.fromTick += 1;
    this.claimPending = true;
    this.wakeWorker?.();
  }

  private startSseSubscription(): void {
    const abort = new AbortController();
    this.sseAbort = abort;
    const url = `${this.opts.novaUrl.replace(/\/$/, '')}/agents/${encodeURIComponent(
      this.opts.agentId,
    )}/inbox/stream`;

    this.sseHandle = streamSseEvents({
      url,
      signal: abort.signal,
      getHeaders: () => ({ authorization: `Bearer ${this.opts.mintSelfUcan()}` }),
      onOpen: () => this.opts.logger.info({ url }, 'inbox SSE connected'),
      onReconnect: (_attempt, delay, cause) =>
        this.opts.logger.warn({ delay, cause }, 'inbox SSE reconnecting'),
      onEvent: () => this.trigger('sse'),
    });
  }

  private async runWorker(): Promise<void> {
    try {
      while (!this.stopping) {
        if (!this.claimPending) {
          await this.waitForTrigger();
          continue;
        }
        if (this.opts.dispatcher.isFull) {
          // Leave claimPending set so we re-enter this branch once the
          // dispatcher drains. Park briefly to avoid a tight loop.
          await this.sleep(50);
          continue;
        }

        // Drain: pull with a short wait and dispatch until the inbox
        // reports empty or we hit an error. Resetting the flag BEFORE the
        // pull means a notification that arrives mid-pull will re-arm us
        // for another drain iteration.
        this.claimPending = false;
        await this.drainOnce();
      }
    } finally {
      this.running = false;
    }
  }

  private async drainOnce(): Promise<void> {
    try {
      this.totalPulls += 1;
      const result = await this.opts.client.pull(
        this.opts.agentId,
        this.opts.mintSelfUcan(),
        CLAIM_WAIT_MS,
        this.stopSignal.signal,
      );
      this.consecutiveErrors = 0;

      if (!result) return; // 204 — nothing to claim, stop the drain cycle

      this.totalTasks += 1;
      this.lastTaskAt = new Date().toISOString();
      this.opts.logger.info(
        { taskId: result.task.taskId, intent: result.task.intent },
        'task claimed',
      );

      // Fire-and-forget dispatch so we can loop back for more.
      void this.opts.dispatcher
        .dispatch(result.task, result.visibleUntil)
        .catch((err) =>
          this.opts.logger.error(
            { err: err.message, taskId: result.task.taskId },
            'dispatch rejected unexpectedly',
          ),
        );

      // More tasks might be queued — re-arm and let the worker loop
      // decide whether to drain again (dispatcher might be full now).
      this.claimPending = true;
    } catch (err: any) {
      if (this.stopping) return;

      this.totalPullErrors += 1;
      this.consecutiveErrors += 1;
      this.lastErrorAt = new Date().toISOString();

      const delay = this.nextBackoff();
      if (err instanceof TransportError) {
        this.opts.logger.warn({ err: err.message, delay }, 'claim transport error; backing off');
      } else if (err instanceof HttpError) {
        this.opts.logger.warn(
          { status: err.status, body: err.body, delay },
          'claim http error; backing off',
        );
      } else {
        this.opts.logger.error({ err: err.message, delay }, 'claim unexpected error; backing off');
      }
      await this.sleep(delay);
      // Keep claimPending set so we try again after the backoff.
      this.claimPending = true;
    }
  }

  private waitForTrigger(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeWorker = () => {
        this.wakeWorker = null;
        resolve();
      };
      if (this.claimPending || this.stopping) {
        this.wakeWorker = null;
        resolve();
      }
    });
  }

  private nextBackoff(): number {
    const n = Math.min(this.consecutiveErrors, 10);
    return Math.min(ERROR_BACKOFF_CAP_MS, ERROR_BACKOFF_BASE_MS * 2 ** (n - 1));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
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
