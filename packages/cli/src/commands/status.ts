// packages/cli/src/commands/status.ts
//
// nova status
//
// Checks health of all Nova services and gives a quick network summary:
// tenant count, agent counts by status, pending approvals, quarantine counts.

import { requireConfig } from '../lib/config.js';
import { NovaAdminClient } from '../lib/client.js';
import {
  bold, dim, cyan, green, red, yellow, grey,
  printError, printJson, section,
} from '../lib/fmt.js';
import { ParsedArgs, flag } from '../lib/args.js';

const HELP = `
${bold('nova status')} — show Nova network health and summary

${bold('Usage')}
  nova status [flags]

${bold('Flags')}
  --json    Output raw JSON

${bold('Examples')}
  nova status
`;

export async function cmdStatus(args: ParsedArgs): Promise<void> {
  if (args.help) { console.log(HELP); return; }

  const _overrides = {
    novaUrl:    flag(args.flags, 'nova-url'),
    adminUrl:   flag(args.flags, 'admin-url'),
    adminToken: flag(args.flags, 'admin-token'),
  };
  Object.keys(_overrides).forEach(k => { if ((_overrides as any)[k] === undefined) delete (_overrides as any)[k]; });
  const config = await requireConfig(_overrides);
  const client = new NovaAdminClient(config);

  // Fetch health + agent list in parallel
  const [health, allAgents, tenants] = await Promise.all([
    client.health().catch(err => ({ error: err.message })),
    client.listAgents().catch(() => []),
    client.listTenants().catch(() => []),
  ]);

  if (args.json) {
    printJson({ health, agents: allAgents, tenants });
    return;
  }

  section('Nova status');

  // Services
  const h = health as any;
  if (h.error) {
    console.log(`  ${red('✕')} Could not reach admin API: ${h.error}\n`);
    process.exit(1);
  }

  const overall = h.status === 'up' ? green('● up') : red('✕ ' + (h.status ?? 'unknown'));
  console.log(`  ${bold('Status')}:  ${overall}`);
  console.log();

  if (h.checks) {
    console.log(`  ${bold('Services')}`);
    for (const [svc, check] of Object.entries(h.checks as Record<string, any>)) {
      const ok     = check.status === 'up';
      const icon   = ok ? green('✓') : red('✕');
      const latency = check.latencyMs ? grey(` ${check.latencyMs}ms`) : '';
      const err    = !ok && check.error ? red(` ${check.error}`) : '';
      console.log(`    ${icon} ${svc.padEnd(18)}${latency}${err}`);
    }
    console.log();
  }

  // Network summary
  const active    = (allAgents as any[]).filter(a => a.status === 'active').length;
  const pending   = (allAgents as any[]).filter(a => a.status === 'pending');
  const totalAgents = (allAgents as any[]).length;

  console.log(`  ${bold('Network')}`);
  console.log(`    Tenants:       ${cyan(String(tenants.length))}`);
  console.log(`    Agents:        ${cyan(String(totalAgents))} total  ${green(String(active))} active${pending.length > 0 ? '  ' + yellow(String(pending.length) + ' pending') : ''}`);

  if (pending.length > 0) {
    console.log();
    console.log(yellow(`  ⚠  ${pending.length} agent${pending.length === 1 ? '' : 's'} awaiting approval:`));
    for (const a of pending.slice(0, 5)) {
      console.log(dim(`     nova agent approve --tenant ${a.tenantId} --agent ${a.agentId}`));
    }
    if (pending.length > 5) console.log(dim(`     … and ${pending.length - 5} more`));
  }

  console.log();
}
