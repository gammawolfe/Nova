// packages/cli/src/commands/broker.ts
//
// nova broker summary
// nova broker status --tenant <id> --agent <id>
//
// Shows the state of broker-mode agents — inbox depth, in-flight tasks,
// reply inbox depth. Useful for diagnosing stuck pull-mode agents.

import { requireConfig } from '../lib/config';
import { NovaAdminClient } from '../lib/client';
import {
  bold, dim, cyan, green, yellow, red,
  table, relativeTime, printError, printJson, section,
} from '../lib/fmt';
import { ParsedArgs, flag } from '../lib/args';

const HELP = `
${bold('nova broker')} — inspect broker-mode (pull inbox) agents

${bold('Usage')}
  nova broker summary
  nova broker status --tenant <id> --agent <id>

${bold('Flags')}
  --tenant <id>   Tenant ID (for per-agent status)
  --agent  <id>   Agent ID  (for per-agent status)
  --json          Output raw JSON

${bold('Examples')}
  nova broker summary
  nova broker status --tenant tenant_abc --agent my-agent
`;

export async function cmdBroker(args: ParsedArgs): Promise<void> {
  if (!args.sub || args.help) { console.log(HELP); return; }

  const _overrides = {
    novaUrl:    flag(args.flags, 'nova-url'),
    adminUrl:   flag(args.flags, 'admin-url'),
    adminToken: flag(args.flags, 'admin-token'),
  };
  Object.keys(_overrides).forEach(k => { if ((_overrides as any)[k] === undefined) delete (_overrides as any)[k]; });
  const config = await requireConfig(_overrides);
  const client = new NovaAdminClient(config);

  switch (args.sub) {
    case 'summary': {
      const result = await client.brokerSummary();
      if (args.json) { printJson(result); return; }
      section('Broker summary');
      const entries: any[] = result.entries ?? [];
      if (entries.length === 0) {
        console.log(dim('  No broker-mode agents registered.\n'));
        return;
      }
      table(entries, [
        { header: 'Agent',       key: 'agentId',       width: 22, render: v => cyan(v) },
        { header: 'Tenant',      key: 'tenantId',       width: 20, render: v => dim(v) },
        { header: 'Inbox',       key: 'inboxDepth',     width: 8,  render: v => v > 0 ? yellow(String(v)) : dim('0') },
        { header: 'In-flight',   key: 'inFlightCount',  width: 10, render: v => v > 0 ? yellow(String(v)) : dim('0') },
        { header: 'Replies',     key: 'replyDepth',     width: 8,  render: v => v > 0 ? cyan(String(v)) : dim('0') },
        { header: 'Last claim',  key: 'lastClaimAt',    width: 12, render: v => v ? dim(relativeTime(v)) : dim('—') },
      ]);
      console.log(dim(`\n  ${entries.length} broker-mode agent${entries.length === 1 ? '' : 's'}\n`));
      break;
    }
    case 'status': {
      const tenantId = flag(args.flags, 'tenant', 't');
      const agentId  = flag(args.flags, 'agent',  'a');
      if (!tenantId) { printError('--tenant is required'); process.exit(1); }
      if (!agentId)  { printError('--agent is required');  process.exit(1); }

      const s = await client.brokerStatus(tenantId, agentId);
      if (args.json) { printJson(s); return; }

      section(`Broker status — ${cyan(agentId)}`);
      console.log(`  ${bold('Inbox depth')}:   ${s.inboxDepth > 0 ? yellow(String(s.inboxDepth)) : dim('0')}`);
      console.log(`  ${bold('In-flight')}:     ${s.inFlightCount > 0 ? yellow(String(s.inFlightCount)) : dim('0')}`);
      console.log(`  ${bold('Reply depth')}:   ${s.replyDepth > 0 ? cyan(String(s.replyDepth)) : dim('0')}`);
      if (s.lastClaimAt)  console.log(`  ${bold('Last claim')}:    ${relativeTime(s.lastClaimAt)}`);
      if (s.lastRespondAt) console.log(`  ${bold('Last respond')}: ${relativeTime(s.lastRespondAt)}`);

      if (s.inFlightCount > 0) {
        console.log();
        console.log(yellow(`  ⚠  ${s.inFlightCount} task${s.inFlightCount === 1 ? '' : 's'} claimed but not yet responded to`));
        console.log(dim('     They will be redelivered when the visibility timeout (5min) expires.'));
      }
      console.log();
      break;
    }
    default:
      printError(`Unknown subcommand: nova broker ${args.sub}`);
      console.log(HELP);
      process.exit(1);
  }
}
