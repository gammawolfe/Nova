import { describe, it, expect } from 'vitest';
import { HealthServer } from '../src/health-server';
import type { ReceiverConfig } from '../src/config';

function fakeDeps() {
  return {
    pullLoop: {
      getStats: () => ({
        running: true,
        totalPulls: 5,
        totalTasks: 2,
        totalPullErrors: 0,
        consecutiveErrors: 0,
      }),
    } as any,
    dispatcher: {
      getStats: () => ({
        inFlight: 1,
        totalDispatched: 2,
        totalResponded: 1,
        totalHandlerErrors: 0,
        totalTransportErrors: 0,
      }),
    } as any,
  };
}

function mkConfig(port: number): ReceiverConfig {
  return {
    agentId: 'test-agent',
    novaUrl: 'http://localhost:3001',
    handler: 'echo',
    handlerConfig: {},
    pollWaitMs: 30_000,
    maxConcurrentTasks: 1,
    healthPort: port,
    shutdownGraceSeconds: 30,
    logLevel: 'info',
  };
}

describe('HealthServer', () => {
  it('does not bind when healthPort = 0', async () => {
    const { pullLoop, dispatcher } = fakeDeps();
    const h = new HealthServer({ config: mkConfig(0), pullLoop, dispatcher, startedAt: new Date() });
    const port = await h.start();
    expect(port).toBe(0);
    await h.stop(); // no-op but must not throw
  });

  it('binds to 127.0.0.1 on an ephemeral port and serves /health', async () => {
    const { pullLoop, dispatcher } = fakeDeps();
    const h = new HealthServer({
      config: mkConfig(0), // 0 means "don't start" via our guard, so force:
      pullLoop,
      dispatcher,
      startedAt: new Date(),
    });
    // Directly override the healthPort so start() actually binds.
    (h as any).opts.config = mkConfig(45_678);
    // Use a fresh port via OS-assigned binding instead; rewrite opts:
    (h as any).opts.config = { ...mkConfig(0), healthPort: 0 };
    // Still 0 — skip this path. Use a real random port:
    const realConfig = mkConfig(Math.floor(Math.random() * 10_000) + 40_000);
    const h2 = new HealthServer({ config: realConfig, pullLoop, dispatcher, startedAt: new Date() });
    const port = await h2.start();
    try {
      expect(port).toBe(realConfig.healthPort);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.agentId).toBe('test-agent');
      expect(body.status).toBe('ok');
      expect(body.pullLoop.running).toBe(true);
      expect(body.dispatcher.inFlight).toBe(1);
    } finally {
      await h2.stop();
    }
  });

  it('reports status=stopped when pull loop is not running', async () => {
    const pullLoop: any = {
      getStats: () => ({
        running: false,
        totalPulls: 5,
        totalTasks: 2,
        totalPullErrors: 0,
        consecutiveErrors: 0,
      }),
    };
    const { dispatcher } = fakeDeps();
    const port = Math.floor(Math.random() * 10_000) + 40_000;
    const h = new HealthServer({ config: mkConfig(port), pullLoop, dispatcher, startedAt: new Date() });
    await h.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(503);
      const body = await res.json() as any;
      expect(body.status).toBe('stopped');
    } finally {
      await h.stop();
    }
  });

  it('reports status=degraded after consecutive errors', async () => {
    const pullLoop: any = {
      getStats: () => ({
        running: true,
        totalPulls: 5,
        totalTasks: 0,
        totalPullErrors: 3,
        consecutiveErrors: 3,
      }),
    };
    const { dispatcher } = fakeDeps();
    const port = Math.floor(Math.random() * 10_000) + 40_000;
    const h = new HealthServer({ config: mkConfig(port), pullLoop, dispatcher, startedAt: new Date() });
    await h.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200); // still live
      const body = await res.json() as any;
      expect(body.status).toBe('degraded');
    } finally {
      await h.stop();
    }
  });

  it('returns 404 on unknown paths', async () => {
    const { pullLoop, dispatcher } = fakeDeps();
    const port = Math.floor(Math.random() * 10_000) + 40_000;
    const h = new HealthServer({ config: mkConfig(port), pullLoop, dispatcher, startedAt: new Date() });
    await h.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await h.stop();
    }
  });
});
