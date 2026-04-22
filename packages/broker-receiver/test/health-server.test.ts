import { describe, it, expect } from 'vitest';
import { HealthServer } from '../src/health-server';
import type { ReceiverConfig } from '../src/config';

function fakeDeps(overrides: { running?: boolean; consecutiveErrors?: number } = {}) {
  return {
    claimLoop: {
      getStats: () => ({
        running: overrides.running ?? true,
        totalPulls: 5,
        totalTasks: 2,
        totalPullErrors: overrides.consecutiveErrors ?? 0,
        consecutiveErrors: overrides.consecutiveErrors ?? 0,
        triggers: { fromSse: 1, fromTick: 4 },
        sse: {
          enabled: true,
          connected: true,
          reconnectCount: 0,
          eventsReceived: 1,
          lastEventId: 1,
        },
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
    inboxStrategy: 'push',
    pollFallbackMs: 30_000,
    maxConcurrentTasks: 1,
    healthPort: port,
    shutdownGraceSeconds: 30,
    logLevel: 'info',
  };
}

describe('HealthServer', () => {
  it('does not bind when healthPort = 0', async () => {
    const { claimLoop, dispatcher } = fakeDeps();
    const h = new HealthServer({ config: mkConfig(0), claimLoop, dispatcher, startedAt: new Date() });
    const port = await h.start();
    expect(port).toBe(0);
    await h.stop();
  });

  it('binds to 127.0.0.1 on an ephemeral port and serves /health', async () => {
    const { claimLoop, dispatcher } = fakeDeps();
    const realConfig = mkConfig(Math.floor(Math.random() * 10_000) + 40_000);
    const h = new HealthServer({ config: realConfig, claimLoop, dispatcher, startedAt: new Date() });
    const port = await h.start();
    try {
      expect(port).toBe(realConfig.healthPort);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.agentId).toBe('test-agent');
      expect(body.status).toBe('ok');
      expect(body.claimLoop.running).toBe(true);
      expect(body.claimLoop.sse.enabled).toBe(true);
      expect(body.claimLoop.triggers.fromSse).toBe(1);
      expect(body.dispatcher.inFlight).toBe(1);
    } finally {
      await h.stop();
    }
  });

  it('reports status=stopped when claim loop is not running', async () => {
    const { claimLoop, dispatcher } = fakeDeps({ running: false });
    const port = Math.floor(Math.random() * 10_000) + 40_000;
    const h = new HealthServer({ config: mkConfig(port), claimLoop, dispatcher, startedAt: new Date() });
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
    const { claimLoop, dispatcher } = fakeDeps({ running: true, consecutiveErrors: 3 });
    const port = Math.floor(Math.random() * 10_000) + 40_000;
    const h = new HealthServer({ config: mkConfig(port), claimLoop, dispatcher, startedAt: new Date() });
    await h.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.status).toBe('degraded');
    } finally {
      await h.stop();
    }
  });

  it('returns 404 on unknown paths', async () => {
    const { claimLoop, dispatcher } = fakeDeps();
    const port = Math.floor(Math.random() * 10_000) + 40_000;
    const h = new HealthServer({ config: mkConfig(port), claimLoop, dispatcher, startedAt: new Date() });
    await h.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await h.stop();
    }
  });
});
