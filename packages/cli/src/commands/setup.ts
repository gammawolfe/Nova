// packages/cli/src/commands/setup.ts
//
// nova setup
//
// Interactive first-run wizard that writes ~/.nova/cli.json.
// Also usable non-interactively via flags for scripted environments.
//
// Usage:
//   nova setup
//   nova setup --nova-url https://nova.example.com --admin-url https://nova.example.com --admin-token <token>

import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { writeConfig, readConfig, CONFIG_PATH } from '../lib/config.js';
import { NovaAdminClient } from '../lib/client.js';
import { bold, cyan, green, dim, printSuccess, printError, printWarn } from '../lib/fmt.js';
import { ParsedArgs, flag } from '../lib/args.js';

const HELP = `
${bold('nova setup')} — configure the Nova CLI

Writes connection details to ${dim('~/.nova/cli.json')}. Run once after deploying
Nova, or re-run to update credentials.

${bold('Usage')}
  nova setup [flags]

${bold('Flags')}
  --nova-url    <url>    a2a-server base URL  (default: http://localhost:3001)
  --admin-url   <url>    admin-api base URL   (default: http://localhost:3005)
  --admin-token <token>  operator bearer token
  --no-verify            skip connectivity check after saving

${bold('Examples')}
  nova setup
  nova setup --nova-url https://nova.acme.com --admin-url https://admin.acme.com --admin-token secret
`;

export async function cmdSetup(args: ParsedArgs): Promise<void> {
  if (args.help) { console.log(HELP); return; }

  const existing = await readConfig();

  // Non-interactive path: all flags supplied
  const novaUrlFlag   = flag(args.flags, 'nova-url');
  const adminUrlFlag  = flag(args.flags, 'admin-url');
  const adminTokenFlag = flag(args.flags, 'admin-token');
  const noVerify      = args.flags['no-verify'] === true;

  if (novaUrlFlag && adminUrlFlag && adminTokenFlag) {
    await writeConfig({ novaUrl: novaUrlFlag, adminUrl: adminUrlFlag, adminToken: adminTokenFlag });
    if (!noVerify) await verify(novaUrlFlag, adminUrlFlag, adminTokenFlag);
    return;
  }

  // Interactive path
  console.log(`\n${bold('Nova CLI setup')}\n`);
  console.log(`This writes your connection config to ${cyan(CONFIG_PATH)}\n`);

  const rl = readline.createInterface({ input, output });

  async function prompt(question: string, def?: string): Promise<string> {
    const hint = def ? dim(` [${def}]`) : '';
    const answer = await rl.question(`  ${question}${hint}: `);
    return answer.trim() || def || '';
  }

  const novaUrl    = await prompt('a2a-server URL', existing.novaUrl ?? 'http://localhost:3001');
  const adminUrl   = await prompt('admin-api URL',  existing.adminUrl ?? 'http://localhost:3005');
  const adminToken = await prompt('Admin token',    existing.adminToken);

  rl.close();

  if (!novaUrl || !adminUrl || !adminToken) {
    printError('All three values are required.');
    process.exit(1);
  }

  await writeConfig({ novaUrl, adminUrl, adminToken });
  console.log();
  printSuccess(`Config saved to ${CONFIG_PATH}`);

  if (!noVerify) await verify(novaUrl, adminUrl, adminToken);
}

async function verify(novaUrl: string, adminUrl: string, adminToken: string): Promise<void> {
  process.stdout.write('\n  Verifying connectivity... ');
  try {
    const client = new NovaAdminClient({ novaUrl, adminUrl, adminToken });
    const health = await client.health() as any;
    const overall = health?.status ?? 'unknown';
    if (overall === 'up') {
      console.log(green('✓'));
      console.log(dim('  All services healthy.\n'));
    } else {
      console.log('\n');
      printWarn(`Nova responded but status is "${overall}" — some services may be down.`);
      if (health?.checks) {
        for (const [svc, check] of Object.entries(health.checks as Record<string, any>)) {
          const ok = check.status === 'up';
          console.log(`    ${ok ? green('✓') : dim('✕')} ${svc}: ${check.status}${check.latencyMs ? ` (${check.latencyMs}ms)` : ''}`);
        }
      }
      console.log();
    }
  } catch (err: any) {
    console.log(dim('failed'));
    printWarn(`Could not reach Nova at ${adminUrl}: ${err.message}`);
    console.log(dim('  Config was saved — re-run nova setup if the URL is wrong.\n'));
  }
}
