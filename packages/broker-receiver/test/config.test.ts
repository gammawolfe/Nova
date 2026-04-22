import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  resolveConfig,
  DEFAULT_NOVA_URL,
  DEFAULT_POLL_FALLBACK_MS,
  DEFAULT_MAX_CONCURRENT_TASKS,
} from '../src/config';

async function withTempConfig(contents: unknown, fn: (p: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'broker-receiver-config-'));
  const p = path.join(dir, 'broker-receiver.json');
  await fsp.writeFile(p, JSON.stringify(contents));
  try {
    await fn(p);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

describe('resolveConfig', () => {
  const baseEnv: NodeJS.ProcessEnv = { NOVA_AGENT_ID: 'test-agent' };

  it('applies defaults when only agentId is supplied', async () => {
    const cfg = await resolveConfig({
      cli: { agentId: 'test-agent' },
      env: {},
      configPath: '/nonexistent/broker-receiver.json',
    });
    expect(cfg.agentId).toBe('test-agent');
    expect(cfg.novaUrl).toBe(DEFAULT_NOVA_URL);
    expect(cfg.handler).toBe('echo');
    expect(cfg.pollFallbackMs).toBe(DEFAULT_POLL_FALLBACK_MS);
    expect(cfg.inboxStrategy).toBe('push');
    expect(cfg.maxConcurrentTasks).toBe(DEFAULT_MAX_CONCURRENT_TASKS);
    expect(cfg.healthPort).toBe(0);
    expect(cfg.logLevel).toBe('info');
  });

  it('throws when agentId is missing', async () => {
    await expect(
      resolveConfig({ cli: {}, env: {}, configPath: '/nonexistent/broker-receiver.json' }),
    ).rejects.toThrow();
  });

  it('rejects unknown handler name', async () => {
    await expect(
      resolveConfig({
        cli: { agentId: 'a', handler: 'hallucinated' as any },
        env: {},
        configPath: '/nonexistent/broker-receiver.json',
      }),
    ).rejects.toThrow();
  });

  it('pollFallbackMs bounded to [1000, 60000]', async () => {
    await expect(
      resolveConfig({
        cli: { agentId: 'a', pollFallbackMs: 500 },
        env: {},
        configPath: '/nonexistent/broker-receiver.json',
      }),
    ).rejects.toThrow();
    await expect(
      resolveConfig({
        cli: { agentId: 'a', pollFallbackMs: 120_000 },
        env: {},
        configPath: '/nonexistent/broker-receiver.json',
      }),
    ).rejects.toThrow();
  });

  it('env overrides file', async () => {
    await withTempConfig({ agentId: 'file-agent', novaUrl: 'http://file:3001' }, async (p) => {
      const cfg = await resolveConfig({
        cli: {},
        env: { NOVA_AGENT_ID: 'env-agent', NOVA_URL: 'http://env:3001' },
        configPath: p,
      });
      expect(cfg.agentId).toBe('env-agent');
      expect(cfg.novaUrl).toBe('http://env:3001');
    });
  });

  it('cli overrides env overrides file', async () => {
    await withTempConfig(
      { agentId: 'file', novaUrl: 'http://file:3001', pollFallbackMs: 5_000 },
      async (p) => {
        const cfg = await resolveConfig({
          cli: { pollFallbackMs: 15_000 },
          env: { NOVA_AGENT_ID: 'env-a', BROKER_RECEIVER_POLL_FALLBACK_MS: '10000' },
          configPath: p,
        });
        expect(cfg.agentId).toBe('env-a');
        expect(cfg.novaUrl).toBe('http://file:3001'); // only file sets it
        expect(cfg.pollFallbackMs).toBe(15_000); // cli wins
      },
    );
  });

  it('promotes legacy pollWaitMs to pollFallbackMs', async () => {
    await withTempConfig({ agentId: 'file', pollWaitMs: 7_500 }, async (p) => {
      const cfg = await resolveConfig({ cli: {}, env: {}, configPath: p });
      expect(cfg.pollFallbackMs).toBe(7_500);
    });
  });

  it('pollFallbackMs wins over legacy pollWaitMs when both present', async () => {
    await withTempConfig(
      { agentId: 'file', pollWaitMs: 7_500, pollFallbackMs: 12_000 },
      async (p) => {
        const cfg = await resolveConfig({ cli: {}, env: {}, configPath: p });
        expect(cfg.pollFallbackMs).toBe(12_000);
      },
    );
  });

  it('inboxStrategy accepts push and poll, rejects others', async () => {
    const push = await resolveConfig({
      cli: { agentId: 'a', inboxStrategy: 'push' as const },
      env: {},
      configPath: '/nonexistent/broker-receiver.json',
    });
    expect(push.inboxStrategy).toBe('push');
    const poll = await resolveConfig({
      cli: { agentId: 'a', inboxStrategy: 'poll' as const },
      env: {},
      configPath: '/nonexistent/broker-receiver.json',
    });
    expect(poll.inboxStrategy).toBe('poll');
    await expect(
      resolveConfig({
        cli: { agentId: 'a', inboxStrategy: 'hybrid' as any },
        env: {},
        configPath: '/nonexistent/broker-receiver.json',
      }),
    ).rejects.toThrow();
  });

  it('cli undefined does not wipe earlier tiers', async () => {
    const cfg = await resolveConfig({
      cli: { agentId: undefined, handler: 'echo' as const },
      env: { ...baseEnv },
      configPath: '/nonexistent/broker-receiver.json',
    });
    expect(cfg.agentId).toBe('test-agent');
  });

  it('tolerates missing config file', async () => {
    const cfg = await resolveConfig({
      cli: { agentId: 'a' },
      env: {},
      configPath: '/nonexistent/path/broker-receiver.json',
    });
    expect(cfg.agentId).toBe('a');
  });

  it('rejects non-object config file contents', async () => {
    await withTempConfig([1, 2, 3] as any, async (p) => {
      await expect(
        resolveConfig({ cli: { agentId: 'a' }, env: {}, configPath: p }),
      ).rejects.toThrow();
    });
  });
});
