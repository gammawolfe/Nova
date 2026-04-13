import fsp from 'fs/promises';
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
      const exportedKey = (await fsp.readFile(privateKeyPath, 'utf8')).trim();
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
