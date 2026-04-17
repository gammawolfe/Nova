/**
 * Milestone 5 acceptance — runs the admin UI Playwright suite headless.
 * Spawns its own admin-api via playwright.config.ts webServer, so no
 * external services required beyond Redis.
 */
import { spawn } from 'child_process';
import path from 'path';

const cwd = path.resolve(__dirname, '..');
const child = spawn(
  'npx',
  [
    'playwright',
    'test',
    '--config', 'packages/admin-api/playwright.config.ts',
    '--project', 'chromium',
  ],
  { cwd, stdio: 'inherit', env: { ...process.env } },
);
child.on('exit', (code) => process.exit(code ?? 1));
