// packages/a2a-server/src/key-manager.ts
//
// Module-level singleton owning Nova's notary keypair. Loaded once at
// process start by index.ts#start; downstream code reads via getDid()
// and getKeypair().
//
// First-time setup is intentionally out of scope here: operators run
// `pnpm run generate:keys` to mint and persist the root keypair. The
// previous NOVA_BOOTSTRAP_FRESH_IDENTITY=1 auto-bootstrap path was
// removed because two ways to bootstrap is one too many — and a
// silently-rotated notary DID destroys every UCAN and trust-registry
// entry that referenced the old one.

import fsp from 'fs/promises';
import * as ucans from '@ucans/ucans';
import { logger } from '@nova/shared/src/logger';

let keypair: ucans.EdKeypair | null = null;
let did: string | null = null;

async function initialize(privateKeyPath: string): Promise<void> {
  try {
    const exportedKey = (await fsp.readFile(privateKeyPath, 'utf8')).trim();
    keypair = ucans.EdKeypair.fromSecretKey(exportedKey);
    if (!keypair) throw new Error('KeyManager: EdKeypair.fromSecretKey returned null');
    did = keypair.did();
    logger.info({ did }, 'KeyManager initialized successfully');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      // Distinguish "missing key file" from generic load failures so the
      // operator sees the right remediation in the logs. Don't auto-
      // generate: that would silently rotate the notary DID and orphan
      // every previously-issued UCAN and trust-registry entry.
      const msg =
        `Nova private key not found at ${privateKeyPath}. ` +
        `Run "pnpm run generate:keys" for first-time setup.`;
      logger.error({ path: privateKeyPath }, msg);
      throw new Error(msg);
    }
    logger.error({ err, path: privateKeyPath }, 'Failed to initialize KeyManager');
    throw err;
  }
}

function getKeypair(): ucans.EdKeypair {
  if (!keypair) throw new Error('KeyManager not initialized');
  return keypair;
}

function getDid(): string {
  if (!did) throw new Error('KeyManager not initialized');
  return did;
}

export const keyManager = { initialize, getKeypair, getDid };
