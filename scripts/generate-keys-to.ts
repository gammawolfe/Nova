import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';

async function main() {
  const keysDir = process.argv[2];
  if (!keysDir) {
    console.error('Usage: generate-keys-to.ts <keys-dir>');
    process.exit(1);
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  // did:key derivation for Ed25519: multicodec prefix 0xed01 then 32-byte raw pubkey, base58btc.
  const rawPub = publicKey.export({ type: 'spki', format: 'der' });
  // SPKI DER envelope for Ed25519 ends with the 32-byte raw key.
  const pubBytes = rawPub.slice(-32);
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), pubBytes]);
  const did = 'did:key:z' + bs58.encode(multicodec);

  fs.mkdirSync(keysDir, { recursive: true });
  fs.writeFileSync(path.join(keysDir, 'nova.private.pem'), pem, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(path.join(keysDir, 'nova.did'), did, 'utf8');
}

main().catch((err) => { console.error(err); process.exit(1); });
