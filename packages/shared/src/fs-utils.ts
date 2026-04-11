import fs from 'fs';
import path from 'path';

/**
 * Atomically write data to a file using write-to-temp-then-rename.
 * Safe against partial writes. Creates parent directories as needed.
 */
export function writeAtomically(finalPath: string, data: unknown): void {
  const tmpPath = finalPath + '.tmp.' + process.hrtime.bigint().toString();
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, finalPath); // Atomic on POSIX (same filesystem)
}
