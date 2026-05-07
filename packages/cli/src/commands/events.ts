// packages/cli/src/commands/events.ts
//
// nova events [--filter task|agent|tenant] [--tenant <id>] [--agent <id>]
//
// Streams the live lifecycle event feed from GET /admin/events (SSE).
// This is the primary way for an operator to watch what's happening
// across the network in real time — tasks flowing, agents coming online,
// confirmation gates firing, etc.
//
// Press Ctrl-C to stop.

import { requireConfig } from '../lib/config.js';
import { NovaAdminClient } from '../lib/client.js';
import {
  bold, dim, cyan, green, red, yellow, grey, magenta, blue,
  eventType, taskAction, agentAction,
  printError, ts,
} from '../lib/fmt.js';
import { ParsedArgs, flag } from '../lib/args.js';

const HELP = `
${bold('nova events')} — stream live network events

Connects to Nova's SSE lifecycle stream and prints events as they arrive.
Press ${bold('Ctrl-C')} to stop.

${bold('Usage')}
  nova events [flags]

${bold('Flags')}
  --filter  task|agent|tenant   Show only this event class (default: all)
  --tenant  <id>                Show only events for this tenant
  --agent   <id>                Show only events involving this agent
  --raw                         Print raw JSON event data
  --no-header                   Skip the connection banner

${bold('Event classes')}
  ${cyan('task')}    queued → working → completed/failed/quarantined
  ${magenta('agent')}   created → approved → deregistered
  ${blue('tenant')}  created → updated → deleted

${bold('Examples')}
  nova events
  nova events --filter task
  nova events --tenant tenant_abc
  nova events --filter task --tenant tenant_abc --agent claude-code
  nova events --raw | jq .
`;

export async function cmdEvents(args: ParsedArgs): Promise<void> {
  if (args.help) { console.log(HELP); return; }

  const _overrides = {
    novaUrl:    flag(args.flags, 'nova-url'),
    adminUrl:   flag(args.flags, 'admin-url'),
    adminToken: flag(args.flags, 'admin-token'),
  };
  Object.keys(_overrides).forEach(k => { if ((_overrides as any)[k] === undefined) delete (_overrides as any)[k]; });
  const config = await requireConfig(_overrides);

  const filterClass  = flag(args.flags, 'filter', 'f');
  const filterTenant = flag(args.flags, 'tenant', 't');
  const filterAgent  = flag(args.flags, 'agent',  'a');
  const raw          = args.flags['raw'] === true;
  const noHeader     = args.flags['no-header'] === true;

  const client = new NovaAdminClient(config);
  const url = client.eventsUrl();

  if (!noHeader) {
    console.log();
    console.log(`  ${bold('Nova events')}  ${dim(url)}`);
    const filters: string[] = [];
    if (filterClass)  filters.push(`class=${cyan(filterClass)}`);
    if (filterTenant) filters.push(`tenant=${cyan(filterTenant)}`);
    if (filterAgent)  filters.push(`agent=${cyan(filterAgent)}`);
    if (filters.length) console.log(`  Filters: ${filters.join('  ')}`);
    console.log(dim('  Streaming… press Ctrl-C to stop\n'));
  }

  // Use native fetch streaming — no EventSource dep needed in Node 18+
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err: any) {
    printError(`Could not connect to Nova at ${url}: ${err.message}`);
    process.exit(1);
  }

  if (!res.ok) {
    printError(`SSE stream returned HTTP ${res.status}`);
    process.exit(1);
  }

  if (!res.body) {
    printError('No response body from SSE endpoint');
    process.exit(1);
  }

  // SSE parse state
  let eventName = 'message';
  let dataLines: string[] = [];

  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  let buffer = '';

  process.on('SIGINT', () => {
    console.log(dim('\n\n  Stopped.\n'));
    reader.cancel();
    process.exit(0);
  });

  while (true) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      } else if (line === '') {
        // Dispatch event
        if (dataLines.length > 0) {
          const dataStr = dataLines.join('\n');
          dataLines = [];
          const name = eventName;
          eventName = 'message';

          if (name === 'ready') continue; // connection handshake
          if (line.startsWith(':')) continue; // heartbeat comment

          // Parse and filter
          let data: any;
          try { data = JSON.parse(dataStr); } catch { continue; }

          // Apply filters
          if (filterClass && name !== filterClass) continue;
          if (filterTenant && data.tenantId !== filterTenant && data.toTenantId !== filterTenant) continue;
          if (filterAgent  && data.agentId !== filterAgent  && data.toAgentId !== filterAgent) continue;

          if (raw) {
            console.log(JSON.stringify({ event: name, ...data }));
          } else {
            printEvent(name, data);
          }
        }
      }
    }
  }
}

function printEvent(name: string, data: any): void {
  const stamp = ts();
  const type  = eventType(name);

  switch (name) {
    case 'task':   printTaskEvent(stamp, type, data); break;
    case 'agent':  printAgentEvent(stamp, type, data); break;
    case 'tenant': printTenantEvent(stamp, type, data); break;
    default:       console.log(`${stamp}  ${type}  ${dim(JSON.stringify(data))}`); break;
  }
}

function printTaskEvent(stamp: string, type: string, data: any): void {
  const action   = taskAction(data.action ?? '');
  const to       = data.toAgentId   ? cyan(data.toAgentId)   : dim('?');
  const from     = data.fromAgentId ? dim(data.fromAgentId)  : dim('—');
  const tenant   = data.toTenantId  ? dim(' [' + data.toTenantId + ']') : '';
  const taskId   = data.taskId      ? dim(' ' + data.taskId.slice(0, 8) + '…') : '';

  let line = `${stamp}  ${type}  ${action}  ${from} → ${to}${tenant}${taskId}`;

  // Extra context for specific actions
  if (data.action === 'failed') {
    line = `${stamp}  ${type}  ${taskAction('failed')}  ${from} → ${to}${tenant}${taskId}`;
  } else if (data.action === 'quarantined') {
    line = `${stamp}  ${type}  ${yellow('quarantined')}  ${from} → ${to}${tenant}${taskId}`;
  }

  console.log(line);
}

function printAgentEvent(stamp: string, type: string, data: any): void {
  const action  = agentAction(data.action ?? '');
  const agent   = data.agentId  ? cyan(data.agentId)  : dim('?');
  const tenant  = data.tenantId ? dim(' [' + data.tenantId + ']') : '';
  const status  = data.status   ? dim(' → ' + data.status)   : '';
  console.log(`${stamp}  ${type}  ${action}  ${agent}${tenant}${status}`);
}

function printTenantEvent(stamp: string, type: string, data: any): void {
  const action = data.action ? blue(data.action.padEnd(10)) : dim('?'.padEnd(10));
  const name   = data.name   ? bold(data.name)  : dim('?');
  const id     = data.tenantId ? dim(' [' + data.tenantId + ']') : '';
  console.log(`${stamp}  ${type}  ${action}  ${name}${id}`);
}
