// packages/cli/src/commands/tenant.ts
//
// nova tenant <sub> [flags]
//
//   nova tenant list
//   nova tenant create --name "Acme" --slug acme [--plan developer|pro|enterprise]
//   nova tenant get <tenantId>
//   nova tenant delete <tenantId> [--yes]

import { requireConfig } from '../lib/config.js';
import { NovaAdminClient } from '../lib/client.js';
import {
  bold, dim, cyan, green, red, yellow, table,
  agentStatus, relativeTime, printSuccess, printError, printJson, section,
} from '../lib/fmt.js';
import { ParsedArgs, flag, flagBool } from '../lib/args.js';

const HELP = `
${bold('nova tenant')} — manage tenants (galaxies)

${bold('Usage')}
  nova tenant list
  nova tenant create --name <name> --slug <slug> [--plan developer|pro|enterprise]
  nova tenant get    <tenantId>
  nova tenant delete <tenantId> [--yes]

${bold('Flags')}
  --json    Output raw JSON instead of formatted table
  --yes     Skip confirmation prompt on destructive operations

${bold('Examples')}
  nova tenant list
  nova tenant create --name "Acme Corp" --slug acme --plan pro
  nova tenant get tenant_abc123
  nova tenant delete tenant_abc123 --yes
`;

export async function cmdTenant(args: ParsedArgs): Promise<void> {
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
    case 'list': return tenantList(client, args);
    case 'create': return tenantCreate(client, args);
    case 'get': return tenantGet(client, args);
    case 'delete': case 'rm': return tenantDelete(client, args);
    default:
      printError(`Unknown subcommand: nova tenant ${args.sub}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function tenantList(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const tenants = await client.listTenants();
  if (args.json) { printJson(tenants); return; }

  section('Tenants');
  if (tenants.length === 0) {
    console.log(dim('  No tenants. Create one with: nova tenant create --name "Name" --slug slug\n'));
    return;
  }
  table(tenants, [
    { header: 'ID',      key: 'id',        width: 24 },
    { header: 'Name',    key: 'name',       width: 28 },
    { header: 'Slug',    key: 'slug',       width: 20 },
    { header: 'Plan',    key: 'plan',       width: 12, render: v => cyan(v ?? 'developer') },
    { header: 'Status',  key: 'status',     width: 14, render: v => agentStatus(v ?? 'active') },
    { header: 'Created', key: 'createdAt',  width: 12, render: v => v ? dim(relativeTime(v)) : dim('—') },
  ]);
  console.log(dim(`\n  ${tenants.length} tenant${tenants.length === 1 ? '' : 's'}\n`));
}

async function tenantCreate(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const name = flag(args.flags, 'name');
  const slug = flag(args.flags, 'slug');
  const plan = flag(args.flags, 'plan') ?? 'developer';

  if (!name || !slug) {
    printError('--name and --slug are required');
    console.log(`  Example: nova tenant create --name "Acme" --slug acme`);
    process.exit(1);
  }

  const tenant = await client.createTenant({ name, slug, plan });
  if (args.json) { printJson(tenant); return; }

  printSuccess(`Tenant created`);
  console.log(`  ${bold('ID')}:   ${cyan(tenant.id)}`);
  console.log(`  ${bold('Name')}: ${tenant.name}`);
  console.log(`  ${bold('Slug')}: ${tenant.slug}`);
  console.log(`  ${bold('Plan')}: ${tenant.plan ?? 'developer'}`);
  console.log();
  console.log(dim(`  Next: nova invite mint --tenant ${tenant.id} --agent-id-hint <agentId>\n`));
}

async function tenantGet(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const tenantId = args.positional[0] ?? flag(args.flags, 'tenant');
  if (!tenantId) { printError('tenantId required'); process.exit(1); }

  const tenant = await client.getTenant(tenantId);
  if (args.json) { printJson(tenant); return; }

  section('Tenant');
  console.log(`  ${bold('ID')}:     ${cyan(tenant.id)}`);
  console.log(`  ${bold('Name')}:   ${tenant.name}`);
  console.log(`  ${bold('Slug')}:   ${tenant.slug}`);
  console.log(`  ${bold('Plan')}:   ${tenant.plan ?? 'developer'}`);
  console.log(`  ${bold('Status')}: ${agentStatus(tenant.status ?? 'active')}`);
  if (tenant.createdAt) console.log(`  ${bold('Created')}: ${relativeTime(tenant.createdAt)}`);
  if (tenant.quotas) {
    console.log(`  ${bold('Quotas')}:`);
    console.log(`    messages/day: ${tenant.quotas.messagesPerDay ?? '—'}`);
    console.log(`    max agents:   ${tenant.quotas.agentsMax ?? '—'}`);
  }
  console.log();
}

async function tenantDelete(client: NovaAdminClient, args: ParsedArgs): Promise<void> {
  const tenantId = args.positional[0] ?? flag(args.flags, 'tenant');
  if (!tenantId) { printError('tenantId required'); process.exit(1); }

  if (!flagBool(args.flags, 'yes', 'y')) {
    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve, reject) => {
      rl.question(`  Delete tenant ${red(tenantId)} and all its agents? [y/N] `, ans => {
        rl.close();
        if (ans.trim().toLowerCase() !== 'y') {
          console.log(dim('  Aborted.'));
          process.exit(0);
        }
        resolve();
      });
    });
  }

  await client.deleteTenant(tenantId);
  printSuccess(`Tenant ${tenantId} deleted\n`);
}
