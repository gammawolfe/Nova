#!/usr/bin/env node
// packages/broker-receiver/src/cli.ts
//
// Subcommand dispatcher. Hand-rolled flag parsing because we don't want a
// commander/yargs dep for the ~5 flags the daemon accepts. The flag
// syntax intentionally mirrors kebab-case conventions used elsewhere in
// Nova (e.g. --agent-id, --nova-url).

import { resolveConfig } from './config.js';
import { runDaemon } from './run.js';
import { runInit } from './init.js';
import { generateLaunchdPlist } from './supervision/launchd.js';
import { generateSystemdUnit } from './supervision/systemd.js';

interface ParsedFlags {
  subcommand: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedFlags {
  const [subcommand = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[tok.slice(2)] = next;
          i += 1;
        } else {
          flags[tok.slice(2)] = true;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { subcommand, flags, positional };
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function flagsToCli(flags: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    const key = kebabToCamel(k);
    if (typeof v === 'string') {
      // Coerce numeric-looking strings for int-typed config fields.
      const num = Number(v);
      out[key] = Number.isFinite(num) && /^-?\d+$/.test(v) ? num : v;
    } else {
      out[key] = v;
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`nova broker-receiver — supervised daemon for broker-mode agents

Usage:
  broker-receiver <subcommand> [options]

Subcommands:
  run          Start the daemon. Runs until SIGTERM/SIGINT.
  init         One-shot onboarding: register agent via invite and cache grant.
  install      Print a launchd (macOS) or systemd (Linux) supervision file.
  uninstall    Print the steps to remove supervision (does not modify files).
  help         This message.

Common options (all subcommands):
  --agent-id <id>          Agent ID (required; also accepts NOVA_AGENT_ID env).
  --nova-url <url>         a2a-server base URL. Default http://localhost:3001.
  --handler <name>         Handler to dispatch to. 'echo' or 'claude-api'.
  --config <path>          Config file path. Default ~/.nova/broker-receiver.json.
  --log-level <level>      debug | info | warn | error. Default info.

run options:
  --health-port <n>        Loopback health endpoint port. 0 (default) disables.
  --poll-wait-ms <n>       Long-poll window. Default 30000. Server caps at 60000.
  --max-concurrent-tasks   Concurrent handler slots. Default 1.
  --shutdown-grace-seconds Grace window for in-flight handlers on SIGTERM. Default 30.

init options:
  --invite <jwt>           Invite token minted by the tenant operator.
  --admin-token <token>    Optional — NOVA_ADMIN_TOKEN required for reissue flows.

install options:
  --format <launchd|systemd>  Supervision format. Auto-detected by platform if omitted.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { subcommand, flags } = parseArgs(argv);
  const cli = flagsToCli(flags);

  switch (subcommand) {
    case 'run':      return await cmdRun(cli);
    case 'init':     return await cmdInit(cli);
    case 'install':  return await cmdInstall(cli);
    case 'uninstall':return cmdUninstall();
    case 'help':
    case '--help':
    case '-h':       return printHelp();
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n\n`);
      printHelp();
      process.exit(1);
  }
}

async function cmdRun(cli: Record<string, unknown>): Promise<void> {
  const config = await resolveConfig({
    cli,
    configPath: typeof cli.config === 'string' ? cli.config : undefined,
  });
  const daemon = await runDaemon(config);

  const onSignal = async (signal: NodeJS.Signals) => {
    process.stderr.write(`{"ts":"${new Date().toISOString()}","level":"info","signal":"${signal}","msg":"shutdown signal received"}\n`);
    try {
      await daemon.stop();
      process.exit(0);
    } catch (err: any) {
      process.stderr.write(`{"ts":"${new Date().toISOString()}","level":"error","err":"${err.message}","msg":"shutdown failed"}\n`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // Keep the process alive; runDaemon's internal promises won't resolve
  // until stop() is invoked.
  await new Promise<void>(() => { /* never */ });
}

async function cmdInit(cli: Record<string, unknown>): Promise<void> {
  const invite = typeof cli.invite === 'string' ? cli.invite : undefined;
  const agentId = typeof cli.agentId === 'string'
    ? cli.agentId
    : (typeof cli['agent-id'] === 'string' ? (cli['agent-id'] as string) : undefined);
  if (!invite) {
    process.stderr.write('init: --invite <jwt> is required\n');
    process.exit(1);
  }
  if (!agentId) {
    process.stderr.write('init: --agent-id <id> is required\n');
    process.exit(1);
  }
  const novaUrl = typeof cli.novaUrl === 'string' ? cli.novaUrl : (process.env.NOVA_URL ?? 'http://localhost:3001');
  await runInit({ agentId, invite, novaUrl });
}

async function cmdInstall(cli: Record<string, unknown>): Promise<void> {
  const format = (typeof cli.format === 'string' ? cli.format : (process.platform === 'darwin' ? 'launchd' : 'systemd'));
  const config = await resolveConfig({
    cli,
    configPath: typeof cli.config === 'string' ? cli.config : undefined,
  });
  const nodePath = process.execPath;
  const entryPath = require.resolve('../dist/cli.js');
  if (format === 'launchd') {
    process.stdout.write(generateLaunchdPlist({ agentId: config.agentId, nodePath, entryPath, novaUrl: config.novaUrl, homeDir: process.env.HOME ?? '' }));
  } else if (format === 'systemd') {
    process.stdout.write(generateSystemdUnit({ agentId: config.agentId, nodePath, entryPath, novaUrl: config.novaUrl }));
  } else {
    process.stderr.write(`install: unknown format '${format}'. Expected 'launchd' or 'systemd'.\n`);
    process.exit(1);
  }
}

function cmdUninstall(): void {
  process.stdout.write(`Uninstall (manual):

macOS (launchd):
  launchctl unload ~/Library/LaunchAgents/com.nova.broker-receiver.<agentId>.plist
  rm ~/Library/LaunchAgents/com.nova.broker-receiver.<agentId>.plist

Linux (systemd, user scope):
  systemctl --user stop broker-receiver@<agentId>.service
  systemctl --user disable broker-receiver@<agentId>.service
  rm ~/.config/systemd/user/broker-receiver@.service
  systemctl --user daemon-reload

Identity + grant remain under ~/.nova/ so re-install is non-destructive.
Delete ~/.nova/agents/<agentId>.json to reset the identity completely.
`);
}

main().catch(err => {
  process.stderr.write(`broker-receiver: ${err.stack ?? err.message ?? err}\n`);
  process.exit(1);
});
