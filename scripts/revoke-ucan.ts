/**
 * scripts/revoke-ucan.ts
 * Revoke a previously issued UCAN by writing a tombstone to the revocation list.
 *
 * Usage:
 *   npx tsx scripts/revoke-ucan.ts --cid <sha256-hex> --tenant <tenantId> [--reason <reason>]
 *   npx tsx scripts/revoke-ucan.ts --token <ucanJwt> --tenant <tenantId> [--reason <reason>]
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const DATA_ROOT = process.env.DATA_ROOT || path.resolve(process.cwd(), 'data');

function usage(): never {
  console.error(`
Usage:
  npx tsx scripts/revoke-ucan.ts --cid <sha256-hex> --tenant <tenantId> [--reason <text>]
  npx tsx scripts/revoke-ucan.ts --token <ucanJwt> --tenant <tenantId> [--reason <text>]
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const tenantId = get('--tenant') ?? usage();
  const reason = get('--reason') ?? 'operator_revoked';

  let cid: string;

  const tokenArg = get('--token');
  const cidArg = get('--cid');

  if (tokenArg) {
    cid = crypto.createHash('sha256').update(tokenArg).digest('hex');
  } else if (cidArg) {
    cid = cidArg;
  } else {
    usage();
  }

  const revokedDir = path.join(DATA_ROOT, 'tenants', tenantId, 'ucans', 'revoked');
  fs.mkdirSync(revokedDir, { recursive: true });

  const tombstone = {
    cid,
    revokedAt: new Date().toISOString(),
    reason,
  };

  const tombstonePath = path.join(revokedDir, cid + '.json');
  if (fs.existsSync(tombstonePath)) {
    console.log(`⚠️  UCAN already revoked: ${cid}`);
    process.exit(0);
  }

  // Write tombstone atomically
  const tmpPath = tombstonePath + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(tombstone, null, 2), 'utf8');
  fs.renameSync(tmpPath, tombstonePath);

  // Also update the issued metadata if it exists
  const issuedPath = path.join(DATA_ROOT, 'tenants', tenantId, 'ucans', 'issued', cid + '.json');
  if (fs.existsSync(issuedPath)) {
    const issued = JSON.parse(fs.readFileSync(issuedPath, 'utf8'));
    const updated = { ...issued, revoked: true, revokedAt: tombstone.revokedAt, revokedReason: reason };
    const tmpIssued = issuedPath + '.tmp.' + Date.now();
    fs.writeFileSync(tmpIssued, JSON.stringify(updated, null, 2), 'utf8');
    fs.renameSync(tmpIssued, issuedPath);
  }

  console.log(`\n✅ UCAN revoked`);
  console.log(`CID:     ${cid}`);
  console.log(`Reason:  ${reason}`);
  console.log(`Time:    ${tombstone.revokedAt}`);
  console.log(`\nTombstone written to: ${tombstonePath}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
