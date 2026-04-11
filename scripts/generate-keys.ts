import fs from 'fs';
import path from 'path';
import * as ucans from '@ucans/ucans';

const keysDir = path.join(process.cwd(), 'data', 'keys');

async function main() {
  console.log('Generating Nova cryptographic identity...');
  
  // Nova uses Ed25519 keys via ucans natively. We must explicitly flag it as exportable
  // so we can write the private key to a file for the a2a-server to read later.
  const keypair = await ucans.EdKeypair.create({ exportable: true });
  
  // For standard capability extraction, although ucan uses Ed25519 under the hood, 
  // we want to ensure we format out the raw secrets accurately.
  // ucan's `export()` yields a specific string format we need to securely store.
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
