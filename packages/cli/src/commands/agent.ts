// packages/cli/src/commands/agent.ts
//
// nova agent <sub> [flags]
//
//   nova agent list [--tenant <id>]
//   nova agent get  --tenant <id> --agent <id>
//   nova agent approve --tenant <id> --agent <id> [--tier 1|2|3] [--expiry-days 30]
//   nova agent reject  --tenant <id> --agent <id>
//   nova agent delete  --tenant <id> --agent <id> [--yes]
//   nova agent reissue --tenant <id> --agent <id>

import { requireConfig } from '../lib/config.js';
import { NovaAdminClient } from '../lib/client.js';
import {
  bold, dim, cyan, green, yellow, red, magenta,
  table, agentStatus, trustTier, relativeTime,
  printSuccess, printError, printJson, printWarn, section,
} from '../lib/fmt.js';
import { ParsedArgs, flag, flagBool, flagInt } from '../lib/args.js';

const HELP = `
${bold('nova agent')} — manage agents (planets)

${bold('Usage')}
  nova agent list    [--tenant <id>]
  nova agent get     --tenant <id> --agent <id>
  nova agent approve --tenant <id> --agent <id> [--tier 1|2|3] [--expiry-days 30]
  nova agent reject  --tenant <id> --agent <id>
  nova agent delete  --tenant <id> --agent <id> [--yes]
  nova agent reissue --tenant <id> --agent <id>

${bold('Flags')}
  --tenant  <id>    Tenant ID (omit to list across all tenants)
  --agent   <id>    Agent ID
  --tier    1|2|3   Trust tier on approval (default: 1)
  --expiry-days <n> UCAN grant expiry in days (default: 30)
  --yes             Skip confirmation on destructive ops
  --json            Output raw JSON

${bold('Trust tiers')}
  1 = restricted   2 = standard   3 = privileged

${bold('Examples')}
  nova agent list
  nova agent list --tenant tenant_abc
  nova agent approve --tenant tenant_abc --agent claude-code --tier 2
  nova agent reject  --tenant tenant_abc --agent bad-agent
  nova agent reissue --tenant tenant_abc --agent claude-code
`;

export async function cmdAgent(args: ParsedArgs): Promise<void> {
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
    case 'list':    return agentList(client, args);
    case 'get':     return agentGet(client, args);
    case 'approve': return agentApprove(client, args);
    case 'reject':  return agentReject(client, args);
    case 'delete': case 'rm': return agentDelete(client, args);
    case 'reissue': return agentReissue(client, args);
    default:
      printError(`Unknown subcommand: nova agent ${args.sub}`);
      console.log(HELP);
      process.exit(1);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function requireTenantAgent(args: ParsedArgs): { tenantId: string; agentId: string } {
  const tenantId = flag(args.flags, 'tenant', 't') ?? args.positional[0];
  const agentId  = flag(args.flags, 'agent',  'a') ?? args.positional[1];
  if (!tenantId) { printError('--tenant is required'); process.exit(1); }
  if (!agentId)  { printError('--agent is required');  process.exit(1); }
  return { tenantId, agentId };
}

// ── Commands ───────────────────────────────────────────────────────────────

async function agentList(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const tenantId = flag(args.flags, 'tenant', 't');
  const agents = await client.listAgents(tenantId);
  if (args.json) { printJson(agents); return; }

  section(tenantId ? `Agents in ${cyan(tenantId)}` : 'All agents');
  if (agents.length === 0) {
    console.log(dim('  No agents.'));
    if (tenantId) {
      console.log(dim(`  Mint an invite: nova invite mint --tenant ${tenantId} --agent-id-hint <id>\n`));
    }
    return;
  }

  table(agents, [
    { header: 'Agent ID',  key: 'agentId',   width: 24 },
    { header: 'Name',      key: 'name',       width: 24 },
    { header: 'Tenant',    key: 'tenantId',   width: 20, render: v => dim(v ?? '—') },
    { header: 'Status',    key: 'status',     width: 18, render: v => agentStatus(v) },
    { header: 'Tier',      key: 'trustTier',  width: 6,  render: v => v != null ? trustTier(v) : dim('—') },
    { header: 'Model',     key: 'description',width: 22, render: (_, r) => dim(r.model ?? r.description?.slice(0, 20) ?? '—') },
    { header: 'Updated',   key: 'updatedAt',  width: 10, render: v => v ? dim(relativeTime(v)) : dim('—') },
  ]);

  const pending = agents.filter((a: any) => a.status === 'pending');
  if (pending.length > 0) {
    console.log();
    console.log(yellow(`  ⚠  ${pending.length} pending agent${pending.length === 1 ? '' : 's'} awaiting approval`));
    console.log(dim(`     Approve with: nova agent approve --tenant <tenantId> --agent <agentId>\n`));
  } else {
    console.log(dim(`\n  ${agents.length} agent${agents.length === 1 ? '' : 's'}\n`));
  }
}

async function agentGet(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const { tenantId, agentId } = requireTenantAgent(args);
  const agent = await client.getAgent(tenantId, agentId);
  if (args.json) { printJson(agent); return; }

  section(`Agent: ${cyan(agentId)}`);
  console.log(`  ${bold('ID')}:          ${cyan(agent.agentId)}`);
  console.log(`  ${bold('Name')}:        ${agent.name}`);
  console.log(`  ${bold('Tenant')}:      ${agent.tenantId}`);
  console.log(`  ${bold('Status')}:      ${agentStatus(agent.status)}`);
  if (agent.trustTier != null) {
    console.log(`  ${bold('Trust tier')}: ${trustTier(agent.trustTier)}`);
  }
  if (agent.did) {
    console.log(`  ${bold('DID')}:        ${dim(agent.did)}`);
  }
  if (agent.operatorUrl) {
    console.log(`  ${bold('Webhook')}:    ${agent.operatorUrl}`);
  } else {
    console.log(`  ${bold('Mode')}:       broker (pull inbox)`);
  }
  if (agent.skills?.length) {
    console.log(`  ${bold('Skills')}:`);
    for (const skill of agent.skills) {
      console.log(`    ${green('·')} ${skill.id} — ${dim(skill.description?.slice(0, 60) ?? skill.name)}`);
    }
  }
  if (agent.createdAt) console.log(`  ${bold('Created')}:     ${relativeTime(agent.createdAt)}`);
  if (agent.updatedAt) console.log(`  ${bold('Updated')}:     ${relativeTime(agent.updatedAt)}`);
  console.log();
}

async function agentApprove(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const { tenantId, agentId } = requireTenantAgent(args);
  const tier        = flagInt(args.flags, 'tier', 1);
  const expiryDays  = flagInt(args.flags, 'expiry-days', 30);
  const notes       = flag(args.flags, 'notes', 'note');

  if (tier < 1 || tier > 3) {
    printError('--tier must be 1, 2, or 3');
    process.exit(1);
  }

  const result = await client.approveAgent(tenantId, agentId, {
    trustTier: tier,
    ucanExpiryDays: expiryDays,
    allowedSkills: ['*'],
    notes,
  });

  if (args.json) { printJson(result); return; }

  printSuccess(`Agent ${cyan(agentId)} approved`);
  console.log(`  ${bold('Trust tier')}:   ${trustTier(tier)}`);
  console.log(`  ${bold('Grant expiry')}: ${expiryDays} days`);
  if (result.grant?.expiresAt) {
    console.log(`  ${bold('Grant CID')}:   ${dim(result.grant.cid)}`);
  }
  console.log();
  console.log(dim('  The agent will pick up its UCAN grant on next nova_check_registration call.'));
  console.log(dim(`  Watch it come online: nova events\n`));
}

async function agentReject(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const { tenantId, agentId } = requireTenantAgent(args);
  await client.rejectAgent(tenantId, agentId);
  if (args.json) { printJson({ status: 'rejected', agentId }); return; }
  printSuccess(`Agent ${cyan(agentId)} rejected and removed\n`);
}

async function agentDelete(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const { tenantId, agentId } = requireTenantAgent(args);

  if (!flagBool(args.flags, 'yes', 'y')) {
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>(resolve => {
      rl.question(`  Deregister agent ${red(agentId)}? [y/N] `, ans => {
        rl.close();
        if (ans.trim().toLowerCase() !== 'y') {
          console.log(dim('  Aborted.'));
          process.exit(0);
        }
        resolve();
      });
    });
  }

  await client.deleteAgent(tenantId, agentId);
  if (args.json) { printJson({ status: 'deregistered', agentId }); return; }
  printSuccess(`Agent ${cyan(agentId)} deregistered\n`);
}

async function agentReissue(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const { tenantId, agentId } = requireTenantAgent(args);
  const result = await client.reissueGrant(tenantId, agentId);
  if (args.json) { printJson(result); return; }

  printSuccess(`Grant reissued for ${cyan(agentId)}`);
  console.log(`  ${bold('Expires')}: ${new Date(result.expiresAt).toLocaleString()}`);
  console.log(`  ${bold('CID')}:     ${dim(result.cid)}`);
  console.log();
  console.log(dim('  Agent should call nova_check_registration to pick up the new grant.\n'));
}
