import fs from 'fs';
import path from 'path';
import * as ucans from '@ucans/ucans';
import { KEY_ROOT } from '../packages/shared/src/tenant';
import { buildDidWeb, validateDidWebHost } from '../packages/shared/src/did-document';

const keysDir = KEY_ROOT;

function parseArgs(argv: string[]): { didWebHost: string | null } {
  let didWebHost: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith('--did-web=')) {
      didWebHost = validateDidWebHost(arg.slice('--did-web='.length));
    } else if (arg === '--did-web') {
      throw new Error('--did-web requires a value, e.g. --did-web=nova.family.com');
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return { didWebHost };
}

function printUsage(): void {
  console.log(`Usage: tsx scripts/generate-keys.ts [--did-web=<host[:port]>]

Generates Nova's Ed25519 signing key and writes it (PEM) to
data/keys/nova.private.pem. Writes Nova's identity to data/keys/nova.did.

Without --did-web: writes the did:key form derived from the public key.
With --did-web:    writes did:web:<host> (port colon-encoded as %3A).
                   The did:web form requires the public key to be served
                   at https://<host>/.well-known/did.json — Nova's a2a-server
                   does this automatically when nova.did is in did:web form.
`);
}

async function main(): Promise<void> {
  const { didWebHost } = parseArgs(process.argv.slice(2));

  console.log('Generating Nova cryptographic identity...');

  const keypair = await ucans.EdKeypair.create({ exportable: true });
  const exported = await keypair.export();
  const didKey = keypair.did();
  const didToWrite = didWebHost ? buildDidWeb(didWebHost) : didKey;

  fs.mkdirSync(keysDir, { recursive: true });

  const privateKeyPath = path.join(keysDir, 'nova.private.pem');
  const didPath = path.join(keysDir, 'nova.did');

  fs.writeFileSync(privateKeyPath, exported, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(didPath, didToWrite, 'utf8');

  console.log('Identity Generated Successfully!');
  console.log(`DID written to ${didPath}: ${didToWrite}`);
  if (didWebHost) {
    console.log(`(did:key equivalent: ${didKey})`);
    console.log(`Ensure https://${didWebHost}/.well-known/did.json is reachable — Nova's a2a-server publishes it from this key when nova.did is in did:web form.`);
  }
  console.log(`Private key saved to ${privateKeyPath} (mode 0600)`);
}

main().catch(err => {
  console.error('Failed to generate keys:', err.message ?? err);
  process.exit(1);
});
