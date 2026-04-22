// packages/broker-receiver/src/logger.ts
//
// Minimal structured-JSON logger. One line per log call, stderr only so
// stdout stays clean for anything the CLI wants to emit as data.
// Launchd and systemd both capture stderr into files/journal.

import type { Logger } from './handlers/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export function createLogger(level: Level = 'info'): Logger {
  const threshold = LEVELS[level];

  function emit(lvl: Level, obj: Record<string, unknown>, msg?: string): void {
    if (LEVELS[lvl] < threshold) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      ...obj,
    };
    if (msg) entry.msg = msg;
    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  return {
    debug: (obj, msg) => emit('debug', obj, msg),
    info:  (obj, msg) => emit('info',  obj, msg),
    warn:  (obj, msg) => emit('warn',  obj, msg),
    error: (obj, msg) => emit('error', obj, msg),
  };
}
