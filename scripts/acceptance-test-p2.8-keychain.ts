/**
 * P2.8 — Keychain backend acceptance test.
 *
 * Exercises packages/mcp-server/src/identity.ts + key-backend.ts end-to-end
 * with both backends. Does NOT require admin-api / a2a-server — pure local
 * identity persistence.
 *
 * The keychain portion writes to the real OS keychain/libsecret. We guard
 * it behind NOVA_TEST_KEYCHAIN=1 so CI / headless environments where the
 * keychain isn't available can still run the file-backend half.
 *
 *   NOVA_TEST_KEYCHAIN=1 npm run test:acceptance:p2.8
 */

import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';

function assert(c: boolean, msg: string): asserts c {
  if (!c) { console.error(`[FAIL] ${msg}`); process.exit(1); }
}

// Route NOVA_HOME to a per-run tempdir so we never touch the user's real
// ~/.nova state. Set before importing any mcp-server modules so paths.ts
// picks it up at module load.
const testHome = path.join(os.tmpdir(), 'nova-p2.8-' + randomBytes(4).toString('hex'));
process.env['NOVA_HOME'] = testHome;

async function withBackend<T>(name: 'file' | 'keychain', fn: () => Promise<T>): Promise<T> {
  const prior = process.env['NOVA_KEY_BACKEND'];
  process.env['NOVA_KEY_BACKEND'] = name;
  try { return await fn(); }
  finally {
    if (prior === undefined) delete process.env['NOVA_KEY_BACKEND'];
    else process.env['NOVA_KEY_BACKEND'] = prior;
  }
}

async function main() {
  console.log('=== P2.8 KEYCHAIN BACKEND ACCEPTANCE TEST ===\n');
  console.log(`Using NOVA_HOME=${testHome}\n`);

  // Dynamic import so NOVA_HOME is already set before paths.ts resolves.
  const { generateIdentity, saveIdentity, loadIdentity, sign } = await import('../packages/mcp-server/src/identity.js');
  const { getKeyBackend } = await import('../packages/mcp-server/src/key-backend.js');

  // ── 1. File backend — default / legacy layout preserved ─────────────────
  console.log('--- File backend (default): save + load round-trip ---');
  await withBackend('file', async () => {
    const identity = generateIdentity('file_test_a');
    await saveIdentity(identity);
    const loaded = await loadIdentity('file_test_a');
    assert(!!loaded, 'loaded identity should be non-null');
    assert(loaded!.did === identity.did, 'did roundtrip');
    assert(loaded!.privateKeyPem === identity.privateKeyPem, 'PEM roundtrip');
    assert(loaded!.keyBackend === 'file', `keyBackend marker should be file, got ${loaded!.keyBackend}`);

    const onDisk = JSON.parse(await fsp.readFile(path.join(testHome, 'agents', 'file_test_a.json'), 'utf8'));
    assert(onDisk.privateKeyPem === identity.privateKeyPem, 'PEM should be inline on disk for file backend');

    // Signing end-to-end works (consumers all read identity.privateKeyPem).
    const sig = sign(loaded!.privateKeyPem, 'test');
    assert(sig.length > 0, 'sign should produce a signature');
    console.log('[PASS] file backend: inline PEM, roundtrip, sign\n');
  });

  // ── 2. Invalid NOVA_KEY_BACKEND value — explicit error ──────────────────
  console.log('--- Invalid backend value ---');
  await withBackend('wat' as any, async () => {
    try {
      getKeyBackend();
      console.error('[FAIL] should have thrown on invalid backend');
      process.exit(1);
    } catch (err: any) {
      assert(err.message.includes('NOVA_KEY_BACKEND'), `expected backend error, got: ${err.message}`);
      console.log('[PASS] invalid backend rejected\n');
    }
  });

  if (process.env['NOVA_TEST_KEYCHAIN'] !== '1') {
    console.log('[SKIP] Keychain tests — set NOVA_TEST_KEYCHAIN=1 to run.\n');
    console.log('=== P2.8 FILE-BACKEND TESTS PASSED ===');
    return;
  }

  // ── 3. Keychain backend — PEM not on disk ──────────────────────────────
  console.log('--- Keychain backend: save writes PEM to keychain, not JSON ---');
  await withBackend('keychain', async () => {
    const identity = generateIdentity('kc_test_a');
    await saveIdentity(identity);

    const onDisk = JSON.parse(await fsp.readFile(path.join(testHome, 'agents', 'kc_test_a.json'), 'utf8'));
    assert(!onDisk.privateKeyPem, `PEM should NOT be on disk; got length=${onDisk.privateKeyPem?.length ?? 0}`);
    assert(onDisk.keyBackend === 'keychain', `keyBackend marker should be keychain, got ${onDisk.keyBackend}`);

    const loaded = await loadIdentity('kc_test_a');
    assert(!!loaded, 'loaded identity should be non-null');
    assert(loaded!.privateKeyPem === identity.privateKeyPem, 'PEM should be materialised from keychain on load');

    const sig = sign(loaded!.privateKeyPem, 'kc probe');
    assert(sig.length > 0, 'sign should work after keychain materialise');
    console.log('[PASS] keychain backend: PEM stripped from disk, materialised on load\n');
  });

  // ── 4. Migration — file-layout JSON + NOVA_KEY_BACKEND=keychain ─────────
  console.log('--- Migration: legacy file JSON → keychain on load ---');
  await withBackend('file', async () => {
    const identity = generateIdentity('mig_test');
    await saveIdentity(identity);
    // Simulate pre-P2.8 records by stripping keyBackend field.
    const p = path.join(testHome, 'agents', 'mig_test.json');
    const raw = JSON.parse(await fsp.readFile(p, 'utf8'));
    delete raw.keyBackend;
    await fsp.writeFile(p, JSON.stringify(raw, null, 2));
  });
  await withBackend('keychain', async () => {
    const loaded = await loadIdentity('mig_test');
    assert(!!loaded, 'migration load should succeed');
    assert(loaded!.privateKeyPem.includes('PRIVATE KEY'), 'materialised PEM should be valid');

    // After migration the on-disk JSON should have been rewritten.
    const onDisk = JSON.parse(await fsp.readFile(path.join(testHome, 'agents', 'mig_test.json'), 'utf8'));
    assert(!onDisk.privateKeyPem, 'post-migration JSON should have no inline PEM');
    assert(onDisk.keyBackend === 'keychain', 'post-migration JSON should mark keychain backend');

    // A second load picks up from keychain alone (no re-migration).
    const reloaded = await loadIdentity('mig_test');
    assert(reloaded!.privateKeyPem === loaded!.privateKeyPem, 'subsequent load returns same PEM');
    console.log('[PASS] migration: PEM moved to keychain, JSON rewritten idempotently\n');
  });

  // ── 5. Orphaned-metadata case — JSON says keychain but entry missing ────
  console.log('--- Orphaned metadata: JSON references keychain but entry absent ---');
  await withBackend('keychain', async () => {
    const identity = generateIdentity('orphan_test');
    await saveIdentity(identity);
    // Nuke the keychain entry out-of-band.
    const { Entry } = await import('@napi-rs/keyring');
    try { new Entry('nova-agent', 'orphan_test').deletePassword(); } catch { /* already gone */ }

    try {
      await loadIdentity('orphan_test');
      console.error('[FAIL] load should have thrown for orphaned-keychain case');
      process.exit(1);
    } catch (err: any) {
      assert(err.message.includes('keychain'), `expected keychain-related error, got: ${err.message}`);
      console.log('[PASS] orphaned keychain entry surfaces a clear error\n');
    }
  });

  // ── Cleanup keychain entries ───────────────────────────────────────────
  const { Entry } = await import('@napi-rs/keyring');
  for (const id of ['kc_test_a', 'mig_test']) {
    try { new Entry('nova-agent', id).deletePassword(); } catch { /* ok */ }
  }

  console.log('=== ALL P2.8 KEYCHAIN TESTS PASSED ===');
}

main()
  .catch(err => {
    console.error('Acceptance test failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    // Best-effort tempdir cleanup so rerunning the test doesn't pile up files.
    try { await fsp.rm(testHome, { recursive: true, force: true }); } catch { /* ok */ }
  });
