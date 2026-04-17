import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';

const keysDir = path.join(process.cwd(), 'data', 'keys');

function main() {
  console.log('Generating Nova cryptographic identity...');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const rawPub = publicKey.export({ type: 'spki', format: 'der' });
  const pubBytes = rawPub.slice(-32);
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), pubBytes]);
  const did = 'did:key:z' + bs58.encode(multicodec);

  fs.mkdirSync(keysDir, { recursive: true });

  const privateKeyPath = path.join(keysDir, 'nova.private.pem');
  const didPath = path.join(keysDir, 'nova.did');

  fs.writeFileSync(privateKeyPath, pem, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(didPath, did, 'utf8');

  console.log('✅ Identity Generated Successfully!');
  console.log('DID:', did);
  console.log(`Private Key saved securely to: ${privateKeyPath}`);
}

main();
