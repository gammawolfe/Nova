import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bs58 from 'bs58';
import { KEY_ROOT } from '../packages/shared/src/tenant';
import { buildDidWeb, validateDidWebHost } from '../packages/shared/src/did-document';

const keysDir = KEY_ROOT;

// did:key multicodec prefix for Ed25519 public keys. Per the did:key
// spec, the DID is `did:key:z` + base58btc(0xed01 || raw_pub_key_32).
const ED25519_MULTICODEC_PREFIX = Uint8Array.of(0xed, 0x01);

/**
 * Slice the raw 32-byte Ed25519 public key out of a Node KeyObject's SPKI
 * DER export. The SPKI prefix for Ed25519 is fixed at 12 bytes, so a
 * constant-offset subarray is safe.
 */
function rawEd25519PublicKey(pub: crypto.KeyObject): Buffer {
  const der = pub.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(12, 44));
}

function deriveDidKey(publicKey: crypto.KeyObject): string {
  const raw = rawEd25519PublicKey(publicKey);
  const prefixed = Buffer.concat([ED25519_MULTICODEC_PREFIX, raw]);
  return `did:key:z${bs58.encode(prefixed)}`;
}

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

Generates Nova's Ed25519 signing key and writes it to
data/keys/nova.private.pem in PKCS8 PEM format. Writes Nova's identity to
data/keys/nova.did.

Without --did-web: writes the did:key form derived from the public key.
With --did-web:    writes did:web:<host> (port colon-encoded as %3A).
                   The did:web form requires the public key to be served
                   at https://<host>/.well-known/did.json — Nova's a2a-server
                   does this automatically when nova.did is in did:web form.

Note on key format: this script now writes PKCS8 PEM (matching the
.pem filename). Existing installs using the legacy ucans 64-byte base64
format continue to work — loadNovaPrivateKey accepts both — but new
installs are canonical PEM going forward. Run scripts/migrate-keys.ts to
convert an old install to PEM in place.
`);
}

async function main(): Promise<void> {
  const { didWebHost } = parseArgs(process.argv.slice(2));

  console.log('Generating Nova cryptographic identity...');

  // PKCS8 PEM is the canonical on-disk format. Matches the .pem filename,
  // is the format Node's crypto module accepts natively, and is the
  // standard representation outside of any specific library's helpers.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pemKey = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  const didKey = deriveDidKey(publicKey);
  const didToWrite = didWebHost ? buildDidWeb(didWebHost) : didKey;

  fs.mkdirSync(keysDir, { recursive: true });

  const privateKeyPath = path.join(keysDir, 'nova.private.pem');
  const didPath = path.join(keysDir, 'nova.did');

  fs.writeFileSync(privateKeyPath, pemKey, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(didPath, didToWrite, 'utf8');

  console.log('Identity Generated Successfully!');
  console.log(`DID written to ${didPath}: ${didToWrite}`);
  if (didWebHost) {
    console.log(`(did:key equivalent: ${didKey})`);
    console.log(`Ensure https://${didWebHost}/.well-known/did.json is reachable — Nova's a2a-server publishes it from this key when nova.did is in did:web form.`);
  }
  console.log(`Private key saved to ${privateKeyPath} (mode 0600, PKCS8 PEM)`);
}

main().catch(err => {
  console.error('Failed to generate keys:', err.message ?? err);
  process.exit(1);
});
