// packages/cli/src/commands/audit.ts
//
// nova audit tail --tenant <id> [--limit 50] [--event <type>] [--task <id>]
// nova audit task --tenant <id> --task <id>
//
// Queries the audit log for a tenant. For live streaming, use `nova events`.

import { requireConfig } from '../lib/config.js';
import { NovaAdminClient } from '../lib/client.js';
import {
  bold, dim, cyan, green, red, yellow, grey,
  table, relativeTime, printError, printJson, section,
} from '../lib/fmt.js';
import { ParsedArgs, flag, flagInt } from '../lib/args.js';

const HELP = `
${bold('nova audit')} — query the operator audit log

${bold('Usage')}
  nova audit tail  --tenant <id> [flags]
  nova audit task  --tenant <id> --task <taskId>

${bold('Flags')}
  --tenant  <id>     Tenant ID ${yellow('(required)')}
  --task    <id>     Filter by task UUID
  --event   <type>   Filter by event type (e.g. task_completed, task_started)
  --from    <iso>    Start of time range (ISO 8601)
  --to      <iso>    End of time range (ISO 8601)
  --limit   <n>      Max results (default: 50, max: 200)
  --json             Output raw JSON

${bold('Examples')}
  nova audit tail --tenant tenant_abc
  nova audit tail --tenant tenant_abc --event task_completed --limit 20
  nova audit task --tenant tenant_abc --task 550e8400-e29b-41d4-a716-446655440000
`;

const EVENT_COLORS: Record<string, (s: string) => string> = {
  task_completed:  green,
  task_started:    cyan,
  task_expired:    yellow,
  task_broker_queued: cyan,
  delivery_success: green,
  delivery_permanent_failure: red,
  delivery_transient_failure: yellow,
  dead_letter_written: red,
  confirm_approved: green,
  confirm_denied: red,
  confirm_requested: yellow,
  reply_delivered: green,
  reply_broker_queued: cyan,
};

function colorEvent(event: string): string {
  const fn = EVENT_COLORS[event];
  return fn ? fn(event) : dim(event);
}

export async function cmdAudit(args: ParsedArgs): Promise<void> {
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
    case 'tail': return auditTail(client, args);
    case 'task': return auditTask(client, args);
    default:
      printError(`Unknown subcommand: nova audit ${args.sub}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function auditTail(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const tenantId = flag(args.flags, 'tenant', 't') ?? args.positional[0];
  if (!tenantId) { printError('--tenant is required'); process.exit(1); }

  const events = await client.queryAudit(tenantId, {
    event:  flag(args.flags, 'event'),
    from:   flag(args.flags, 'from'),
    to:     flag(args.flags, 'to'),
    taskId: flag(args.flags, 'task'),
    limit:  flagInt(args.flags, 'limit', 50),
  });

  if (args.json) { printJson(events); return; }

  section(`Audit log — ${cyan(tenantId)}`);
  if (events.length === 0) {
    console.log(dim('  No audit events found.\n'));
    return;
  }

  table(events, [
    { header: 'Time',    key: 'timestamp',  width: 10, render: v => v ? dim(relativeTime(v)) : dim('—') },
    { header: 'Event',   key: 'event',      width: 36, render: v => colorEvent(v) },
    { header: 'Agent',   key: 'agentId',    width: 20, render: v => v ? cyan(v) : dim('—') },
    { header: 'Task',    key: 'taskId',     width: 38, render: v => v ? dim(v) : dim('—') },
  ]);
  console.log(dim(`\n  ${events.length} event${events.length === 1 ? '' : 's'}\n`));
}

async function auditTask(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const tenantId = flag(args.flags, 'tenant', 't');
  const taskId   = flag(args.flags, 'task') ?? args.positional[0];

  if (!tenantId) { printError('--tenant is required'); process.exit(1); }
  if (!taskId)   { printError('--task is required');   process.exit(1); }

  const events = await client.getTaskAudit(tenantId, taskId);
  if (args.json) { printJson(events); return; }

  section(`Task audit — ${dim(taskId)}`);
  if (events.length === 0) {
    console.log(dim('  No audit events for this task.\n'));
    return;
  }

  // Print as a timeline
  for (const e of events) {
    const time = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 23) : '??:??:??.???';
    const meta = e.metadata ? '  ' + dim(JSON.stringify(e.metadata)) : '';
    console.log(`  ${grey(time)}  ${colorEvent(e.event)}${meta}`);
  }
  console.log();
}
