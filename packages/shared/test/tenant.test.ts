// packages/shared/test/tenant.test.ts
//
// Unit tests for resolveDataRoot — the workspace-root walk-up that backs
// DATA_ROOT. Each case is a pure function call with explicit env + startDir,
// so the tests don't depend on the surrounding CWD.

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveDataRoot } from '../src/tenant';

describe('resolveDataRoot', () => {
  it('returns the DATA_ROOT env value when set, ignoring the workspace walk', () => {
    const result = resolveDataRoot({
      startDir: '/anywhere/at/all',
      env: { DATA_ROOT: '/explicit/data/root' },
    });
    expect(result).toBe('/explicit/data/root');
  });

  it('walks up to the nearest package.json with a workspaces field', () => {
    // Build a tiny fake workspace under tmp:
    //   <tmp>/fake-ws/                          (workspaces: ['packages/*'])
    //   <tmp>/fake-ws/packages/inner/src/
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-walkup-'));
    try {
      const wsRoot = path.join(tmp, 'fake-ws');
      const innerSrc = path.join(wsRoot, 'packages', 'inner', 'src');
      fs.mkdirSync(innerSrc, { recursive: true });
      fs.writeFileSync(
        path.join(wsRoot, 'package.json'),
        JSON.stringify({ name: 'fake-ws', workspaces: ['packages/*'] }),
      );
      fs.writeFileSync(
        path.join(wsRoot, 'packages', 'inner', 'package.json'),
        JSON.stringify({ name: 'inner' }),
      );

      const result = resolveDataRoot({ startDir: innerSrc, env: {} });
      // realpathSync handles macOS /var → /private/var symlink so equality holds.
      expect(result).toBe(path.join(fs.realpathSync(wsRoot), 'data'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('walks past intermediate package.json files that have no workspaces field', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-walkup-'));
    try {
      const wsRoot = path.join(tmp, 'fake-ws');
      const innerSrc = path.join(wsRoot, 'packages', 'inner', 'src');
      fs.mkdirSync(innerSrc, { recursive: true });
      fs.writeFileSync(
        path.join(wsRoot, 'package.json'),
        JSON.stringify({ name: 'fake-ws', workspaces: ['packages/*'] }),
      );
      // Intermediate package.json without workspaces — must NOT be selected.
      fs.writeFileSync(
        path.join(wsRoot, 'packages', 'inner', 'package.json'),
        JSON.stringify({ name: 'inner' }),
      );

      const result = resolveDataRoot({ startDir: innerSrc, env: {} });
      expect(result).toBe(path.join(fs.realpathSync(wsRoot), 'data'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to process.cwd()/../../data with a warning when no workspace root is found', () => {
    // Start in a directory with no workspaces marker in any ancestor.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-no-ws-'));
    try {
      const warn = vi.fn();
      const result = resolveDataRoot({
        startDir: tmp,
        env: {},
        warn,
      });
      expect(result).toBe(path.resolve(process.cwd(), '../../data'));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DATA_ROOT env var not set/));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not warn when the env var is set', () => {
    const warn = vi.fn();
    resolveDataRoot({
      startDir: '/anywhere',
      env: { DATA_ROOT: '/data' },
      warn,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('tolerates unparseable package.json files in the walk path', () => {
    // Mirror real-world: a broken package.json shouldn't halt the walk.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-bad-pkg-'));
    try {
      const wsRoot = path.join(tmp, 'fake-ws');
      const innerSrc = path.join(wsRoot, 'packages', 'inner', 'src');
      fs.mkdirSync(innerSrc, { recursive: true });
      fs.writeFileSync(
        path.join(wsRoot, 'package.json'),
        JSON.stringify({ name: 'fake-ws', workspaces: ['*'] }),
      );
      // Garbage at intermediate level — must be skipped.
      fs.writeFileSync(
        path.join(wsRoot, 'packages', 'inner', 'package.json'),
        '{ this is not json',
      );

      const result = resolveDataRoot({ startDir: innerSrc, env: {} });
      expect(result).toBe(path.join(fs.realpathSync(wsRoot), 'data'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
