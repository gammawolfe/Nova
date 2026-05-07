// packages/cli/src/commands/invite.ts
//
// nova invite mint --tenant <id> --agent-id-hint <hint> [--ttl 3600] [--note "..."]
//
// Mints a one-time invite JWT and prints it — ready to paste into an agent's
// nova_accept_invite call. The token is printed prominently because it's the
// only time it's visible.

import { requireConfig } from '../lib/config.js';
import { NovaAdminClient } from '../lib/client.js';
import {
  bold, dim, cyan, yellow, printError, printJson, section,
} from '../lib/fmt.js';
import { ParsedArgs, flag, flagInt } from '../lib/args.js';

const HELP = `
${bold('nova invite')} — mint one-time agent invite tokens

${bold('Usage')}
  nova invite mint --tenant <tenantId> --agent-id-hint <agentId> [flags]

${bold('Flags')}
  --tenant        <id>    Target tenant ID ${yellow('(required)')}
  --agent-id-hint <id>    Agent ID the token is intended for ${yellow('(required)')}
  --ttl           <secs>  Token TTL in seconds (default: 3600, max: 604800)
  --note          <text>  Optional note attached to the invite
  --json                  Output raw JSON

${bold('Examples')}
  nova invite mint --tenant tenant_abc --agent-id-hint claude-code
  nova invite mint --tenant tenant_abc --agent-id-hint openclaw --ttl 7200 --note "for dev laptop"
`;

export async function cmdInvite(args: ParsedArgs): Promise<void> {
  if (!args.sub || args.help) { console.log(HELP); return; }

  if (args.sub !== 'mint') {
    printError(`Unknown subcommand: nova invite ${args.sub}`);
    console.log(HELP);
    process.exit(1);
  }

  const _overrides = {
    novaUrl:    flag(args.flags, 'nova-url'),
    adminUrl:   flag(args.flags, 'admin-url'),
    adminToken: flag(args.flags, 'admin-token'),
  };
  Object.keys(_overrides).forEach(k => { if ((_overrides as any)[k] === undefined) delete (_overrides as any)[k]; });
  const config = await requireConfig(_overrides);

  const tenantId    = flag(args.flags, 'tenant', 't');
  const agentIdHint = flag(args.flags, 'agent-id-hint', 'agent-id');
  const ttlSeconds  = flagInt(args.flags, 'ttl', 3600);
  const note        = flag(args.flags, 'note');

  if (!tenantId)    { printError('--tenant is required');         process.exit(1); }
  if (!agentIdHint) { printError('--agent-id-hint is required');  process.exit(1); }

  const client = new NovaAdminClient(config);
  const invite = await client.mintInvite(tenantId, { agentIdHint, ttlSeconds, note });

  if (args.json) { printJson(invite); return; }

  section('Invite minted');
  console.log(`  ${bold('Tenant')}:     ${cyan(invite.tenantId)}`);
  console.log(`  ${bold('Agent hint')}: ${invite.agentIdHint ?? agentIdHint}`);
  console.log(`  ${bold('JTI')}:        ${dim(invite.jti)}`);
  console.log(`  ${bold('Expires')}:    ${new Date(invite.expiresAt).toLocaleString()}`);
  if (note) console.log(`  ${bold('Note')}:       ${note}`);
  console.log();
  console.log(bold('  Token (share this with the agent operator):'));
  console.log();
  console.log(`  ${cyan(invite.token)}`);
  console.log();
  console.log(dim('  The agent pastes this into nova_accept_invite, then calls nova_register_agent.'));
  console.log(dim('  After registration, approve with: nova agent approve --tenant ' + tenantId + ' --agent ' + agentIdHint + '\n'));
}
