// packages/mcp-server/src/key-backend.ts
//
// Pluggable backend for agent private-key storage. Selected via the
// NOVA_KEY_BACKEND env var:
//
//   file       (default) — PEM is stored inline in ~/.nova/agents/{agentId}.json
//                          at mode 0o600. Matches the behaviour that existed
//                          before this abstraction, so unset env / container /
//                          CI deployments keep working unchanged.
//
//   keychain            — PEM is stored in the OS credential store (macOS
//                          Keychain, Linux libsecret, Windows Credential
//                          Manager) via @napi-rs/keyring. The identity JSON
//                          on disk holds only metadata + `keyBackend:"keychain"`
//                          as a marker; the private key never touches disk.
//
// The abstraction is intentionally narrow: only saveIdentity/loadIdentity in
// identity.ts branch on the backend. All downstream code (UCAN PoP signing,
// rotation, send-task) continues to receive a fully-materialised Identity
// via loadIdentity and never knows which backend supplied the PEM.
import { Entry } from '@napi-rs/keyring';

export type KeyBackendName = 'file' | 'keychain';

export interface KeyBackend {
  name: KeyBackendName;
  storePrivateKey(agentId: string, pem: string): Promise<void>;
  loadPrivateKey(agentId: string): Promise<string | null>;
  deletePrivateKey(agentId: string): Promise<void>;
}

// Single service namespace keeps all Nova agent keys grouped in the keychain.
// Account = agentId. Two MCP instances for the same agent on the same host
// therefore share the same keychain entry — same sharing semantics as the
// file backend, and the withCacheLock around UCAN cache mutations already
// serialises concurrent writes against the identity file.
const KEYCHAIN_SERVICE = 'nova-agent';

class KeychainBackend implements KeyBackend {
  readonly name = 'keychain' as const;

  async storePrivateKey(agentId: string, pem: string): Promise<void> {
    new Entry(KEYCHAIN_SERVICE, agentId).setPassword(pem);
  }

  async loadPrivateKey(agentId: string): Promise<string | null> {
    try {
      return new Entry(KEYCHAIN_SERVICE, agentId).getPassword();
    } catch (err: any) {
      // @napi-rs/keyring surfaces a "no entry" error per backend — keytar on
      // macOS throws "The specified item could not be found in the keychain",
      // libsecret throws "Not found". Normalise both to null so callers treat
      // missing and not-readable distinctly.
      const msg = (err?.message ?? '').toLowerCase();
      if (msg.includes('not found') || msg.includes('could not be found') || msg.includes('no matching entry')) {
        return null;
      }
      throw err;
    }
  }

  async deletePrivateKey(agentId: string): Promise<void> {
    try {
      new Entry(KEYCHAIN_SERVICE, agentId).deletePassword();
    } catch {
      // Missing is not an error for a delete — idempotent.
    }
  }
}

// The file backend is a no-op at this layer: identity.ts writes the PEM
// inline into the identity JSON, which saveIdentity already did before this
// abstraction existed. Keeping a concrete implementation so the shape is
// symmetric and tests can exercise either backend through the same surface.
class FileBackend implements KeyBackend {
  readonly name = 'file' as const;
  async storePrivateKey(): Promise<void> { /* inline in identity JSON */ }
  async loadPrivateKey(): Promise<string | null> { return null; }
  async deletePrivateKey(): Promise<void> { /* removed with the JSON file */ }
}

export function getKeyBackend(): KeyBackend {
  const raw = (process.env['NOVA_KEY_BACKEND'] ?? 'file').toLowerCase();
  if (raw === 'file') return new FileBackend();
  if (raw === 'keychain') return new KeychainBackend();
  throw new Error(
    `NOVA_KEY_BACKEND="${process.env['NOVA_KEY_BACKEND']}" is invalid. Expected "file" or "keychain".`,
  );
}
