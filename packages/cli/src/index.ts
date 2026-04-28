#!/usr/bin/env node
// packages/cli/src/index.ts
//
// Nova operator CLI — main entry point and command dispatcher.
//
// Usage: nova <command> [subcommand] [flags]

import { parseArgs } from './lib/args';
import { bold, dim, cyan, printError } from './lib/fmt';

import { cmdSetup }      from './commands/setup';
import { cmdTenant }     from './commands/tenant';
import { cmdInvite }     from './commands/invite';
import { cmdAgent }      from './commands/agent';
import { cmdAudit }      from './commands/audit';
import { cmdEvents }     from './commands/events';
import { cmdStatus }     from './commands/status';
import { cmdQuarantine, cmdDl } from './commands/quarantine';
import { cmdTrust, cmdConfirm } from './commands/trust';
import { cmdBroker } from './commands/broker';

const VERSION = '0.1.0';

const ROOT_HELP = `
${bold('nova')} — operator CLI for Nova agent gateway  ${dim('v' + VERSION)}

${bold('Usage')}
  nova <command> [subcommand] [flags]

${bold('Commands')}
  ${cyan('setup')}       Configure CLI credentials  (run this first)
  ${cyan('status')}      Nova health and network summary
  ${cyan('events')}      Stream live task/agent/tenant events

  ${cyan('tenant')}      Manage tenants (galaxies)
  ${cyan('invite')}      Mint one-time agent invite tokens
  ${cyan('agent')}       Manage agents (planets)

  ${cyan('audit')}       Query the operator audit log
  ${cyan('quarantine')}  Review and release quarantined tasks
  ${cyan('dl')}          Inspect the dead-letter queue
  ${cyan('trust')}       Manage per-agent trust registry
  ${cyan('confirm')}     Approve/reject high-privilege task queue
  ${cyan('broker')}      Inspect broker-mode agent inboxes

${bold('Global flags')}
  --help          Show help for any command
  --json          Output raw JSON (machine-readable)
  --nova-url      Override a2a-server URL
  --admin-url     Override admin-api URL
  --admin-token   Override admin bearer token

${bold('Quick start')}
  nova setup
  nova tenant create --name "My Org" --slug my-org
  nova invite mint --tenant <id> --agent-id-hint claude-code
  nova agent list
  nova events

${bold('Documentation')}
  https://github.com/gammawolfe/Nova
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || args.command === 'help') {
    console.log(ROOT_HELP);
    return;
  }

  if (args.flags['version'] || args.flags['v'] === true) {
    console.log(VERSION);
    return;
  }

  try {
    switch (args.command) {
      case 'setup':       await cmdSetup(args);      break;
      case 'status':      await cmdStatus(args);     break;
      case 'events':      await cmdEvents(args);     break;
      case 'tenant':      await cmdTenant(args);     break;
      case 'invite':      await cmdInvite(args);     break;
      case 'agent':       await cmdAgent(args);      break;
      case 'audit':       await cmdAudit(args);      break;
      case 'quarantine':  await cmdQuarantine(args); break;
      case 'dl':          await cmdDl(args);         break;
      case 'trust':       await cmdTrust(args);    break;
      case 'confirm':     await cmdConfirm(args);  break;
      case 'broker':      await cmdBroker(args);   break;

      default:
        printError(`Unknown command: nova ${args.command}`);
        console.log(dim(`  Run ${cyan('nova --help')} to see available commands.\n`));
        process.exit(1);
    }
  } catch (err: any) {
    // ApiError — show the message cleanly, not a stack trace
    if (err.name === 'ApiError' || err.name === 'CliError') {
      printError(err.message);
      process.exit(1);
    }
    // ZodError — validation failures from bad flag inputs
    if (err.name === 'ZodError') {
      printError('Invalid arguments:');
      for (const issue of err.issues ?? []) {
        console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    // Unexpected error — show stack in dev, clean message in prod
    if (process.env.DEBUG) {
      console.error(err);
    } else {
      printError(err.message ?? String(err));
    }
    process.exit(1);
  }
}

main();
