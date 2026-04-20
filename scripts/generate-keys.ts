import fs from 'fs';
import path from 'path';
import * as ucans from '@ucans/ucans';
import { KEY_ROOT } from '../packages/shared/src/tenant';

const keysDir = KEY_ROOT;

async function main() {
  console.log('Generating Nova cryptographic identity...');

  const keypair = await ucans.EdKeypair.create({ exportable: true });
  const exported = await keypair.export();
  const did = keypair.did();

  fs.mkdirSync(keysDir, { recursive: true });

  const privateKeyPath = path.join(keysDir, 'nova.private.pem');
  const didPath = path.join(keysDir, 'nova.did');

  fs.writeFileSync(privateKeyPath, exported, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(didPath, did, 'utf8');

  console.log('✅ Identity Generated Successfully!');
  console.log('DID:', did);
  console.log(`Private Key saved securely to: ${privateKeyPath}`);
}

main().catch(err => {
  console.error('Failed to generate keys:', err);
  process.exit(1);
});
