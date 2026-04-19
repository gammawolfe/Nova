import fsp from 'fs/promises';
import path from 'path';
import * as ucans from '@ucans/ucans';
import { logger } from '@nova/shared/src/logger';

export class KeyManager {
  private static instance: KeyManager;
  private keypair: ucans.EdKeypair | null = null;
  private did: string | null = null;

  private constructor() {}

  public static getInstance(): KeyManager {
    if (!KeyManager.instance) {
      KeyManager.instance = new KeyManager();
    }
    return KeyManager.instance;
  }

  public async initialize(privateKeyPath: string): Promise<void> {
    try {
      let exportedKey: string;
      try {
        exportedKey = (await fsp.readFile(privateKeyPath, 'utf8')).trim();
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;

        // Auto-generating a fresh root keypair rotates Nova's notary DID. Any
        // UCAN previously issued — along with every trust-registry entry that
        // references the old DID — becomes unverifiable. A transient ENOENT
        // (e.g. Docker bind-mount not ready at boot) would silently destroy
        // the trust root. Refuse unless the operator has explicitly opted in.
        if (process.env.NOVA_BOOTSTRAP_FRESH_IDENTITY !== '1') {
          throw new Error(
            `Nova private key not found at ${privateKeyPath}. ` +
            `Run "pnpm run generate:keys" for first-time setup, or set ` +
            `NOVA_BOOTSTRAP_FRESH_IDENTITY=1 to auto-generate. ` +
            `Auto-generation is disabled by default because it rotates the ` +
            `notary DID and orphans all existing UCANs and trust-registry entries.`,
          );
        }

        logger.warn(
          { path: privateKeyPath },
          'NOVA_BOOTSTRAP_FRESH_IDENTITY=1 — generating new root identity. ' +
            'This invalidates any pre-existing UCANs and trust-registry entries.',
        );
        const keypair = await ucans.EdKeypair.create({ exportable: true });
        exportedKey = await keypair.export();
        await fsp.mkdir(path.dirname(privateKeyPath), { recursive: true });
        await fsp.writeFile(privateKeyPath, exportedKey, { encoding: 'utf8', mode: 0o600 });
        await fsp.writeFile(
          path.join(path.dirname(privateKeyPath), 'nova.did'),
          keypair.did(),
          'utf8',
        );
        logger.info({ did: keypair.did() }, 'Generated new identity keypair');
      }
      this.keypair = ucans.EdKeypair.fromSecretKey(exportedKey);
      if (!this.keypair) throw new Error('KeyManager initialization failed natively');
      this.did = this.keypair.did();

      logger.info({ did: this.did }, 'KeyManager initialized successfully');
    } catch (error) {
      logger.error({ err: error, path: privateKeyPath }, 'Failed to initialize KeyManager');
      throw error;
    }
  }

  public getKeypair(): ucans.EdKeypair {
    if (!this.keypair) throw new Error('KeyManager not initialized');
    return this.keypair;
  }

  public getDid(): string {
    if (!this.did) throw new Error('KeyManager not initialized');
    return this.did;
  }
}

export const keyManager = KeyManager.getInstance();
