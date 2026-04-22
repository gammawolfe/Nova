// packages/broker-receiver/src/health-server.ts
//
// Loopback-only HTTP endpoint that surfaces liveness + runtime stats.
// Disabled by default (healthPort = 0). When enabled, bound to 127.0.0.1
// so nothing outside the host can reach it — sufficient for launchd
// health checks, local dashboards, and operator curl.

import http from 'http';
import type { AddressInfo } from 'net';
import type { PullLoop } from './pull-loop.js';
import type { Dispatcher } from './dispatcher.js';
import type { ReceiverConfig } from './config.js';

export interface HealthSnapshot {
  status: 'ok' | 'degraded' | 'stopped';
  agentId: string;
  handler: string;
  uptimeMs: number;
  startedAt: string;
  pullLoop: ReturnType<PullLoop['getStats']>;
  dispatcher: ReturnType<Dispatcher['getStats']>;
}

export interface HealthServerOptions {
  config: ReceiverConfig;
  pullLoop: PullLoop;
  dispatcher: Dispatcher;
  startedAt: Date;
}

export class HealthServer {
  private server: http.Server | null = null;
  private boundPort = 0;

  constructor(private readonly opts: HealthServerOptions) {}

  /**
   * Start listening. Returns the port actually bound (useful when
   * healthPort = 0 was intended but the caller opted in some other way;
   * currently we only start at all when healthPort > 0).
   */
  async start(): Promise<number> {
    if (this.opts.config.healthPort <= 0) return 0;

    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.config.healthPort, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo | null;
    this.boundPort = address?.port ?? 0;
    this.server = server;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = null;
    this.boundPort = 0;
  }

  snapshot(): HealthSnapshot {
    const pull = this.opts.pullLoop.getStats();
    const dispatch = this.opts.dispatcher.getStats();
    const status: HealthSnapshot['status'] =
      !pull.running ? 'stopped'
      : pull.consecutiveErrors >= 3 ? 'degraded'
      : 'ok';
    return {
      status,
      agentId: this.opts.config.agentId,
      handler: this.opts.config.handler,
      startedAt: this.opts.startedAt.toISOString(),
      uptimeMs: Date.now() - this.opts.startedAt.getTime(),
      pullLoop: pull,
      dispatcher: dispatch,
    };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.url === '/health') {
      const snap = this.snapshot();
      const httpStatus = snap.status === 'ok' ? 200 : snap.status === 'degraded' ? 200 : 503;
      res.writeHead(httpStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snap, null, 2));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not_found"}');
  }
}
