// packages/cli/src/commands/quarantine.ts
//
// nova quarantine list  --tenant <id> --agent <id>
// nova quarantine show  --tenant <id> --agent <id> <id>
// nova quarantine release --tenant <id> --agent <id> <id>
// nova quarantine drop  --tenant <id> --agent <id> <id>
//
// nova dl list   --tenant <id> --agent <id>
// nova dl show   --tenant <id> --agent <id> <id>
// nova dl drop   --tenant <id> --agent <id> <id>

import { requireConfig } from '../lib/config.js';
import { NovaAdminClient } from '../lib/client.js';
import {
  bold, dim, cyan, yellow, red, green,
  table, relativeTime, printError, printJson, printSuccess, section,
} from '../lib/fmt.js';
import { ParsedArgs, flag, flagBool } from '../lib/args.js';

const QUARANTINE_HELP = `
${bold('nova quarantine')} — manage the injection quarantine queue

Tasks that fail the gate's injection checks land here for operator review
before being released or discarded.

${bold('Usage')}
  nova quarantine list    --tenant <id> --agent <id>
  nova quarantine show    --tenant <id> --agent <id> <quarantineId>
  nova quarantine release --tenant <id> --agent <id> <quarantineId>
  nova quarantine drop    --tenant <id> --agent <id> <quarantineId>

${bold('Examples')}
  nova quarantine list --tenant tenant_abc --agent my-agent
  nova quarantine release --tenant tenant_abc --agent my-agent abc123
`;

const DL_HELP = `
${bold('nova dl')} — manage the dead-letter queue

Tasks that failed delivery permanently (4xx, inactive sender, etc.)
are stored here for inspection and optional manual discard.

${bold('Usage')}
  nova dl list  --tenant <id> --agent <id>
  nova dl show  --tenant <id> --agent <id> <dlId>
  nova dl drop  --tenant <id> --agent <id> <dlId> [--yes]

${bold('Examples')}
  nova dl list --tenant tenant_abc --agent my-agent
  nova dl drop --tenant tenant_abc --agent my-agent abc123 --yes
`;

function requireTA(args: ParsedArgs) {
  const tenantId = flag(args.flags, 'tenant', 't');
  const agentId  = flag(args.flags, 'agent',  'a');
  if (!tenantId) { printError('--tenant is required'); process.exit(1); }
  if (!agentId)  { printError('--agent is required');  process.exit(1); }
  return { tenantId, agentId };
}

// ── QUARANTINE ─────────────────────────────────────────────────────────────

export async function cmdQuarantine(args: ParsedArgs): Promise<void> {
  if (!args.sub || args.help) { console.log(QUARANTINE_HELP); return; }

  const _overrides = {
    novaUrl:    flag(args.flags, 'nova-url'),
    adminUrl:   flag(args.flags, 'admin-url'),
    adminToken: flag(args.flags, 'admin-token'),
  };
  Object.keys(_overrides).forEach(k => { if ((_overrides as any)[k] === undefined) delete (_overrides as any)[k]; });
  const config = await requireConfig(_overrides);
  const client = new NovaAdminClient(config);
  const { tenantId, agentId } = requireTA(args);

  switch (args.sub) {
    case 'list': {
      const items = await client.listQuarantine(tenantId, agentId);
      if (args.json) { printJson(items); return; }
      section(`Quarantine — ${cyan(agentId)}`);
      if (items.length === 0) { console.log(dim('  Empty.\n')); return; }
      table(items, [
        { header: 'ID',       key: 'id',          width: 12 },
        { header: 'Received', key: 'receivedAt',   width: 12, render: v => dim(relativeTime(v)) },
        { header: 'Step',     key: 'gateStep',     width: 10, render: v => yellow(v) },
        { header: 'Reason',   key: 'reason',       width: 36, render: v => dim(v) },
        { header: 'Status',   key: 'status',       width: 16 },
        { header: 'Sender',   key: 'senderDid',    width: 20, render: v => v ? dim(v.slice(0, 18) + '…') : dim('—') },
      ]);
      console.log(dim(`\n  ${items.length} item${items.length === 1 ? '' : 's'}\n`));
      break;
    }
    case 'show': {
      const id = args.positional[0] ?? flag(args.flags, 'id');
      if (!id) { printError('quarantineId required'); process.exit(1); }
      // No single-item endpoint; list and find
      const items = await client.listQuarantine(tenantId, agentId);
      const item = items.find((i: any) => i.id === id);
      if (!item) { printError(`Item ${id} not found`); process.exit(1); }
      if (args.json) { printJson(item); return; }
      section(`Quarantine item ${cyan(id)}`);
      console.log(`  ${bold('Gate step')}: ${yellow(item.gateStep)}`);
      console.log(`  ${bold('Reason')}:    ${item.reason}`);
      console.log(`  ${bold('Status')}:    ${item.status}`);
      console.log(`  ${bold('Received')}: ${relativeTime(item.receivedAt)}`);
      if (item.senderDid) console.log(`  ${bold('Sender')}:   ${dim(item.senderDid)}`);
      console.log(`\n  ${bold('Raw task')}:\n${dim(JSON.stringify(item.rawTask, null, 2))}\n`);
      break;
    }
    case 'release': {
      const id = args.positional[0] ?? flag(args.flags, 'id');
      if (!id) { printError('quarantineId required'); process.exit(1); }
      await client.releaseQuarantine(tenantId, agentId, id);
      if (args.json) { printJson({ status: 'released', id }); return; }
      printSuccess(`Item ${id} released to delivery queue\n`);
      break;
    }
    case 'drop': {
      const id = args.positional[0] ?? flag(args.flags, 'id');
      if (!id) { printError('quarantineId required'); process.exit(1); }
      await client.dropQuarantine(tenantId, agentId, id);
      if (args.json) { printJson({ status: 'dropped', id }); return; }
      printSuccess(`Item ${id} discarded\n`);
      break;
    }
    default:
      printError(`Unknown subcommand: nova quarantine ${args.sub}`);
      console.log(QUARANTINE_HELP);
      process.exit(1);
  }
}

// ── DEAD LETTER ────────────────────────────────────────────────────────────

export async function cmdDl(args: ParsedArgs): Promise<void> {
  if (!args.sub || args.help) { console.log(DL_HELP); return; }

  const _overrides = {
    novaUrl:    flag(args.flags, 'nova-url'),
    adminUrl:   flag(args.flags, 'admin-url'),
    adminToken: flag(args.flags, 'admin-token'),
  };
  Object.keys(_overrides).forEach(k => { if ((_overrides as any)[k] === undefined) delete (_overrides as any)[k]; });
  const config = await requireConfig(_overrides);
  const client = new NovaAdminClient(config);
  const { tenantId, agentId } = requireTA(args);

  switch (args.sub) {
    case 'list': {
      const items = await client.listDeadLetters(tenantId, agentId);
      if (args.json) { printJson(items); return; }
      section(`Dead-letter queue — ${cyan(agentId)}`);
      if (items.length === 0) { console.log(dim('  Empty.\n')); return; }
      table(items, [
        { header: 'ID',       key: 'id',             width: 12 },
        { header: 'Task',     key: 'taskId',          width: 10, render: v => dim(v?.slice(0, 8) + '…') },
        { header: 'Reason',   key: 'failureReason',   width: 28, render: v => red(v) },
        { header: 'HTTP',     key: 'httpStatus',      width: 6,  render: v => v ? String(v) : dim('—') },
        { header: 'Attempts', key: 'attemptCount',    width: 8 },
        { header: 'Created',  key: 'createdAt',       width: 12, render: v => dim(relativeTime(v)) },
      ]);
      console.log(dim(`\n  ${items.length} item${items.length === 1 ? '' : 's'}\n`));
      break;
    }
    case 'show': {
      const id = args.positional[0] ?? flag(args.flags, 'id');
      if (!id) { printError('dlId required'); process.exit(1); }
      const items = await client.listDeadLetters(tenantId, agentId);
      const item = items.find((i: any) => i.id === id);
      if (!item) { printError(`Item ${id} not found`); process.exit(1); }
      if (args.json) { printJson(item); return; }
      section(`Dead-letter item ${cyan(id)}`);
      console.log(`  ${bold('Task')}:        ${dim(item.taskId)}`);
      console.log(`  ${bold('Reason')}:      ${red(item.failureReason)}`);
      console.log(`  ${bold('HTTP status')}: ${item.httpStatus ?? dim('—')}`);
      console.log(`  ${bold('Attempts')}:    ${item.attemptCount}`);
      console.log(`  ${bold('Target URL')}: ${dim(item.targetUrl)}`);
      console.log(`  ${bold('Created')}:     ${relativeTime(item.createdAt)}`);
      console.log(`  ${bold('Expires')}:     ${item.expiresAt ? relativeTime(item.expiresAt) : dim('—')}`);
      console.log();
      break;
    }
    case 'drop': {
      const id = args.positional[0] ?? flag(args.flags, 'id');
      if (!id) { printError('dlId required'); process.exit(1); }
      if (!flagBool(args.flags, 'yes', 'y')) {
        const { createInterface } = await import('readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        await new Promise<void>(resolve => {
          rl.question(`  Discard dead-letter item ${red(id)}? [y/N] `, ans => {
            rl.close();
            if (ans.trim().toLowerCase() !== 'y') { console.log(dim('  Aborted.')); process.exit(0); }
            resolve();
          });
        });
      }
      await client.dropDeadLetter(tenantId, agentId, id);
      if (args.json) { printJson({ status: 'dropped', id }); return; }
      printSuccess(`Dead-letter item ${id} discarded\n`);
      break;
    }
    default:
      printError(`Unknown subcommand: nova dl ${args.sub}`);
      console.log(DL_HELP);
      process.exit(1);
  }
}
