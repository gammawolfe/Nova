import fs from 'fs';
import path from 'path';
import * as ucans from '@ucans/ucans';

const keysDir = path.join(process.cwd(), 'data', 'keys');
const privateKeyPath = path.join(keysDir, 'nova.private.pem');
const didPath = path.join(keysDir, 'nova.did');

async function main() {
  const isCleanup = process.argv.includes('--cleanup');

  if (isCleanup) {
    // Remove old keys after 24h grace period
    const oldKey = privateKeyPath + '.old';
    const oldDid = didPath + '.old';
    let removed = 0;
    if (fs.existsSync(oldKey)) { fs.unlinkSync(oldKey); removed++; }
    if (fs.existsSync(oldDid)) { fs.unlinkSync(oldDid); removed++; }
    console.log(`Cleanup: removed ${removed} old key file(s)`);
    return;
  }

  // Step 1: Check current keys exist
  if (!fs.existsSync(privateKeyPath)) {
    console.error('No existing keys found. Run generate-keys.ts first.');
    process.exit(1);
  }

  const oldDid = fs.readFileSync(didPath, 'utf8').trim();
  console.log(`Current DID: ${oldDid}`);

  // Step 2: Move current keys to .old
  fs.renameSync(privateKeyPath, privateKeyPath + '.old');
  fs.renameSync(didPath, didPath + '.old');
  console.log('Moved current keys to *.old');

  // Step 3: Generate new keypair
  const keypair = await ucans.EdKeypair.create({ exportable: true });
  const exported = await keypair.export();
  const newDid = keypair.did();

  fs.writeFileSync(privateKeyPath, exported, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(didPath, newDid, 'utf8');

  console.log(`New DID: ${newDid}`);
  console.log('Key rotation complete.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart a2a-server to pick up new keys');
  console.log('  2. After 24h grace period, run: tsx scripts/rotate-keys.ts --cleanup');
}

main().catch(err => {
  console.error('Key rotation failed:', err);
  process.exit(1);
});
