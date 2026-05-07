// packages/cli/src/commands/trust.ts
//
// nova trust list    --tenant <id> --agent <id>
// nova trust revoke  --tenant <id> --agent <id> --did <did>
//
// nova confirm list    --tenant <id> --agent <id>
// nova confirm approve --tenant <id> --agent <id> <id>
// nova confirm reject  --tenant <id> --agent <id> <id>

import { requireConfig } from '../lib/config';
import { NovaAdminClient } from '../lib/client';
import {
  bold, dim, cyan, green, yellow, red,
  table, relativeTime, trustTier,
  printError, printJson, printSuccess, section,
} from '../lib/fmt';
import { ParsedArgs, flag, flagBool } from '../lib/args';

// ── TRUST ──────────────────────────────────────────────────────────────────

const TRUST_HELP = `
${bold('nova trust')} — manage the per-agent trust registry

The trust registry controls which sender DIDs can reach an agent and at
what trust tier. An entry is auto-created when an agent is approved; you
can add additional senders (e.g. agents from another tenant) or revoke
existing ones here.

${bold('Usage')}
  nova trust list   --tenant <id> --agent <id>
  nova trust revoke --tenant <id> --agent <id> --did <did>

${bold('Flags')}
  --tenant <id>   Tenant ID ${yellow('(required)')}
  --agent  <id>   Agent ID  ${yellow('(required)')}
  --did    <did>  DID to revoke (e.g. did:key:z6Mk...)
  --json          Output raw JSON

${bold('Examples')}
  nova trust list   --tenant tenant_abc --agent my-agent
  nova trust revoke --tenant tenant_abc --agent my-agent --did did:key:z6Mk...
`;

export async function cmdTrust(args: ParsedArgs): Promise<void> {
  if (!args.sub || args.help) { console.log(TRUST_HELP); return; }

  const _overrides = {
    novaUrl:    flag(args.flags, 'nova-url'),
    adminUrl:   flag(args.flags, 'admin-url'),
    adminToken: flag(args.flags, 'admin-token'),
  };
  Object.keys(_overrides).forEach(k => { if ((_overrides as any)[k] === undefined) delete (_overrides as any)[k]; });
  const config = await requireConfig(_overrides);
  const client = new NovaAdminClient(config);

  const tenantId = flag(args.flags, 'tenant', 't');
  const agentId  = flag(args.flags, 'agent',  'a');
  if (!tenantId) { printError('--tenant is required'); process.exit(1); }
  if (!agentId)  { printError('--agent is required');  process.exit(1); }

  switch (args.sub) {
    case 'list': {
      const actors = await client.listTrust(tenantId, agentId);
      if (args.json) { printJson(actors); return; }
      section(`Trust registry — ${cyan(agentId)}`);
      if (actors.length === 0) {
        console.log(dim('  No trust entries.\n'));
        return;
      }
      table(actors, [
        { header: 'Display name', key: 'displayName', width: 24 },
        { header: 'DID',          key: 'did',         width: 32, render: v => dim(v?.slice(0, 30) + '…') },
        { header: 'Tier',         key: 'tier',        width: 6,  render: v => v != null ? trustTier(v) : dim('—') },
        { header: 'Skills',       key: 'allowedSkills',width: 20, render: v => Array.isArray(v) ? dim(v.join(', ')) : dim('*') },
        { header: 'Added',        key: 'createdAt',   width: 12, render: v => v ? dim(relativeTime(v)) : dim('—') },
      ]);
      console.log(dim(`\n  ${actors.length} entr${actors.length === 1 ? 'y' : 'ies'}\n`));
      break;
    }
    case 'revoke': {
      const did = flag(args.flags, 'did');
      if (!did) { printError('--did is required'); process.exit(1); }
      await client.revokeTrust(tenantId, agentId, did);
      if (args.json) { printJson({ status: 'removed', did }); return; }
      printSuccess(`Trust entry revoked for ${dim(did)}\n`);
      break;
    }
    default:
      printError(`Unknown subcommand: nova trust ${args.sub}`);
      console.log(TRUST_HELP);
      process.exit(1);
  }
}

// ── CONFIRM ────────────────────────────────────────────────────────────────

const CONFIRM_HELP = `
${bold('nova confirm')} — manage the high-privilege task confirmation queue

Tasks targeting skills marked as high-privilege park here until an
operator explicitly approves or rejects them.

${bold('Usage')}
  nova confirm list    --tenant <id> --agent <id>
  nova confirm approve --tenant <id> --agent <id> <confirmId>
  nova confirm reject  --tenant <id> --agent <id> <confirmId>

${bold('Flags')}
  --tenant <id>   Tenant ID ${yellow('(required)')}
  --agent  <id>   Agent ID  ${yellow('(required)')}
  --json          Output raw JSON

${bold('Examples')}
  nova confirm list --tenant tenant_abc --agent my-agent
  nova confirm approve --tenant tenant_abc --agent my-agent abc123
  nova confirm reject  --tenant tenant_abc --agent my-agent abc123
`;

export async function cmdConfirm(args: ParsedArgs): Promise<void> {
  if (!args.sub || args.help) { console.log(CONFIRM_HELP); return; }

  const _overrides = {
    novaUrl:    flag(args.flags, 'nova-url'),
    adminUrl:   flag(args.flags, 'admin-url'),
    adminToken: flag(args.flags, 'admin-token'),
  };
  Object.keys(_overrides).forEach(k => { if ((_overrides as any)[k] === undefined) delete (_overrides as any)[k]; });
  const config = await requireConfig(_overrides);
  const client = new NovaAdminClient(config);

  const tenantId = flag(args.flags, 'tenant', 't');
  const agentId  = flag(args.flags, 'agent',  'a');
  if (!tenantId) { printError('--tenant is required'); process.exit(1); }
  if (!agentId)  { printError('--agent is required');  process.exit(1); }

  switch (args.sub) {
    case 'list': {
      const items = await client.listConfirmQueue(tenantId, agentId);
      if (args.json) { printJson(items); return; }
      section(`Confirmation queue — ${cyan(agentId)}`);
      if (items.length === 0) {
        console.log(dim('  No items pending confirmation.\n'));
        return;
      }
      table(items, [
        { header: 'ID',      key: 'id',         width: 12 },
        { header: 'Task',    key: 'taskId',      width: 10, render: v => dim(v?.slice(0, 8) + '…') },
        { header: 'Intent',  key: 'intent',      width: 22, render: v => cyan(v ?? '—') },
        { header: 'From',    key: 'fromAgentId', width: 18, render: v => v ? dim(v) : dim('—') },
        { header: 'Expires', key: 'expiresAt',   width: 12, render: v => v ? yellow(relativeTime(v)) : dim('—') },
        { header: 'Status',  key: 'status',      width: 16 },
      ]);
      console.log();
      console.log(dim(`  Approve: nova confirm approve --tenant ${tenantId} --agent ${agentId} <id>`));
      console.log(dim(`  Reject:  nova confirm reject  --tenant ${tenantId} --agent ${agentId} <id>\n`));
      break;
    }
    case 'approve': {
      const id = args.positional[0] ?? flag(args.flags, 'id');
      if (!id) { printError('confirmId required'); process.exit(1); }
      await client.approveConfirm(tenantId, agentId, id);
      if (args.json) { printJson({ status: 'approved', id }); return; }
      printSuccess(`Confirmation item ${id} approved — task released to delivery\n`);
      break;
    }
    case 'reject': {
      const id = args.positional[0] ?? flag(args.flags, 'id');
      if (!id) { printError('confirmId required'); process.exit(1); }
      await client.rejectConfirm(tenantId, agentId, id);
      if (args.json) { printJson({ status: 'rejected', id }); return; }
      printSuccess(`Confirmation item ${id} rejected\n`);
      break;
    }
    default:
      printError(`Unknown subcommand: nova confirm ${args.sub}`);
      console.log(CONFIRM_HELP);
      process.exit(1);
  }
}
