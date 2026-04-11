import fs from 'fs';
import fsp from 'fs/promises';
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

/** Async variant — use in HTTP handlers to avoid blocking the event loop. */
export async function writeAtomicallyAsync(finalPath: string, data: unknown): Promise<void> {
  const tmpPath = finalPath + '.tmp.' + process.hrtime.bigint().toString();
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmpPath, finalPath);
}
