// packages/shared/test/trusted-issuers.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  loadTrustedIssuers,
  isTrustedPeerDid,
  TrustedIssuersError,
} from '../src/trusted-issuers';

let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nova-trusted-issuers-'));
  configPath = path.join(tmpDir, 'trusted-issuers.json');
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('loadTrustedIssuers', () => {
  it('returns an empty set when the file is absent', async () => {
    const set = await loadTrustedIssuers(configPath);
    expect(set.size).toBe(0);
  });

  it('parses { trusted: [...] } object form', async () => {
    await fsp.writeFile(configPath, JSON.stringify({
      trusted: ['did:web:nova.bookstore.com', 'did:web:nova.alice.example'],
    }));
    const set = await loadTrustedIssuers(configPath);
    expect(set.size).toBe(2);
    expect(set.has('did:web:nova.bookstore.com')).toBe(true);
    expect(set.has('did:web:nova.alice.example')).toBe(true);
  });

  it('parses bare array form', async () => {
    await fsp.writeFile(configPath, JSON.stringify(['did:web:nova.bookstore.com']));
    const set = await loadTrustedIssuers(configPath);
    expect(set.has('did:web:nova.bookstore.com')).toBe(true);
  });

  it('accepts both did:web and did:key entries', async () => {
    await fsp.writeFile(configPath, JSON.stringify([
      'did:web:nova.bookstore.com',
      'did:key:z6MkAlice',
    ]));
    const set = await loadTrustedIssuers(configPath);
    expect(set.size).toBe(2);
  });

  it('deduplicates repeated entries', async () => {
    await fsp.writeFile(configPath, JSON.stringify([
      'did:web:nova.bookstore.com',
      'did:web:nova.bookstore.com',
    ]));
    const set = await loadTrustedIssuers(configPath);
    expect(set.size).toBe(1);
  });

  it('returns empty set for an explicitly empty array', async () => {
    await fsp.writeFile(configPath, JSON.stringify([]));
    const set = await loadTrustedIssuers(configPath);
    expect(set.size).toBe(0);
  });

  it('throws TrustedIssuersError on malformed JSON', async () => {
    await fsp.writeFile(configPath, '{not json');
    await expect(loadTrustedIssuers(configPath)).rejects.toThrow(TrustedIssuersError);
    await expect(loadTrustedIssuers(configPath)).rejects.toThrow(/Malformed JSON/);
  });

  it('throws on the wrong top-level shape', async () => {
    await fsp.writeFile(configPath, JSON.stringify({ wrongKey: ['did:web:x'] }));
    await expect(loadTrustedIssuers(configPath)).rejects.toThrow(/array of DIDs or/);
  });

  it('throws on a non-string entry', async () => {
    await fsp.writeFile(configPath, JSON.stringify(['did:web:x', 42]));
    await expect(loadTrustedIssuers(configPath)).rejects.toThrow(/\[1\] is not a string/);
  });

  it('throws on an entry that does not start with did:', async () => {
    await fsp.writeFile(configPath, JSON.stringify(['did:web:x', 'https://nova.evil.example']));
    await expect(loadTrustedIssuers(configPath)).rejects.toThrow(/\[1\] is not a DID/);
  });

  it('surfaces non-ENOENT read errors as TrustedIssuersError', async () => {
    // A directory, not a file — fs.readFile will fail with EISDIR.
    await fsp.mkdir(path.join(tmpDir, 'subdir'));
    await expect(loadTrustedIssuers(path.join(tmpDir, 'subdir'))).rejects.toThrow(TrustedIssuersError);
  });
});

describe('isTrustedPeerDid', () => {
  it('returns true for an exact match', () => {
    const set = new Set(['did:web:nova.bookstore.com']);
    expect(isTrustedPeerDid('did:web:nova.bookstore.com', set)).toBe(true);
  });

  it('returns false for a different DID', () => {
    const set = new Set(['did:web:nova.bookstore.com']);
    expect(isTrustedPeerDid('did:web:nova.attacker.com', set)).toBe(false);
  });

  it('returns false against an empty set', () => {
    expect(isTrustedPeerDid('did:web:nova.bookstore.com', new Set())).toBe(false);
  });

  it('does not perform prefix or glob matching', () => {
    const set = new Set(['did:web:nova.bookstore.com']);
    // A prefix-match implementation would accept this; we want strict equality.
    expect(isTrustedPeerDid('did:web:nova.bookstore.com.attacker.example', set)).toBe(false);
    expect(isTrustedPeerDid('did:web:nova.bookstore.co', set)).toBe(false);
  });

  it('is case-sensitive (DID syntax is case-sensitive in the method-specific id)', () => {
    const set = new Set(['did:web:nova.bookstore.com']);
    expect(isTrustedPeerDid('did:web:Nova.Bookstore.Com', set)).toBe(false);
  });
});
