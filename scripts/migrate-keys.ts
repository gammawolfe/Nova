// scripts/migrate-keys.ts
//
// One-shot in-place conversion of Nova's gateway key file from the legacy
// libsodium 64-byte base64 format to canonical PKCS8 PEM. Idempotent — if
// the file is already PEM, the script reports "already migrated" and
// exits 0 without touching anything.
//
// Why this exists: pre-2026-05 installs of Nova used `ucans.EdKeypair`
// for key generation, which exports a 64-byte (seed || pubkey) base64
// string. The .pem filename was misleading. scripts/generate-keys.ts
// now writes canonical PKCS8 PEM directly; this script lets operators on
// older installs catch up without rotating the key (which would
// invalidate every existing UCAN).
//
// Mechanics:
//   1. Read data/keys/nova.private.pem
//   2. If first byte is `-` (PEM BEGIN marker) → already PEM, exit 0
//   3. Else, base64-decode → expect exactly 64 bytes (seed || pub32)
//   4. Construct a Node KeyObject from a JWK with the seed as `d` and
//      pubkey as `x`, then export as PKCS8 PEM
//   5. Atomic write: temp file → rename, preserving mode 0o600
//
// The derived DID is unchanged — same key, just different on-disk
// representation. Existing UCANs, trust-registry entries, and federation
// grants remain valid.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { KEY_ROOT } from '../packages/shared/src/tenant';

const KEY_PATH = path.join(KEY_ROOT, 'nova.private.pem');

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: tsx scripts/migrate-keys.ts [--dry-run]

Converts the Nova gateway private key file from legacy libsodium 64-byte
base64 to canonical PKCS8 PEM, in place. Idempotent — already-PEM files
are left alone.

Options:
  --dry-run, -n   Report what would happen, write nothing.
`);
      process.exit(0);
    }
  }
  return { dryRun };
}

function main(): void {
  const { dryRun } = parseArgs(process.argv.slice(2));

  let raw: string;
  try {
    raw = fs.readFileSync(KEY_PATH, 'utf8').trim();
  } catch (err: any) {
    console.error(`Cannot read ${KEY_PATH}: ${err.message}`);
    console.error('Run scripts/generate-keys.ts first if this is a fresh install.');
    process.exit(1);
  }

  if (raw.startsWith('-----BEGIN')) {
    console.log(`${KEY_PATH} is already PKCS8 PEM. Nothing to do.`);
    return;
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch (err: any) {
    console.error(`Failed to base64-decode ${KEY_PATH}: ${err.message}`);
    process.exit(2);
  }

  if (decoded.length !== 64) {
    console.error(
      `Unexpected key length: ${decoded.length} bytes. ` +
      `Expected either PKCS8 PEM (starts with "-----BEGIN") or a 64-byte ` +
      `libsodium secretKey base64. The file does not match either format.`,
    );
    process.exit(3);
  }

  const seed = decoded.subarray(0, 32);
  const pub  = decoded.subarray(32, 64);

  let pem: string;
  try {
    const keyObject = crypto.createPrivateKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: seed.toString('base64url'),
        x: pub.toString('base64url'),
      },
      format: 'jwk',
    });
    pem = keyObject.export({ format: 'pem', type: 'pkcs8' }) as string;
  } catch (err: any) {
    console.error(`Failed to reconstruct key as PEM: ${err.message}`);
    process.exit(4);
  }

  if (dryRun) {
    console.log(`Would rewrite ${KEY_PATH} from libsodium 64-byte base64 to PKCS8 PEM.`);
    console.log('(--dry-run: nothing written.)');
    return;
  }

  // Atomic write: temp → rename. Same mode (0o600) as the original.
  const tmpPath = KEY_PATH + '.tmp.' + process.hrtime.bigint().toString();
  try {
    fs.writeFileSync(tmpPath, pem, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, KEY_PATH);
  } catch (err: any) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    console.error(`Failed to write PEM file: ${err.message}`);
    process.exit(5);
  }

  console.log(`Migrated ${KEY_PATH} to PKCS8 PEM.`);
  console.log('The derived DID is unchanged; existing UCANs and trust entries remain valid.');
}

main();
