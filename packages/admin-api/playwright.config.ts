import { defineConfig } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

const PORT = Number(process.env.E2E_PORT ?? 3015);
const BASE_URL = `http://localhost:${PORT}`;
// Must be at least 32 chars to satisfy admin-api/src/config.ts validation.
const ADMIN_TOKEN = 'e2e-admin-token-do-not-use-outside-tests';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-e2e-'));
const keyRoot = path.join(dataRoot, 'keys');
fs.mkdirSync(path.join(dataRoot, 'tenants'), { recursive: true });
fs.mkdirSync(keyRoot, { recursive: true });

// Generate Nova Ed25519 identity keys into the E2E keys root.
// Runs generate-keys.ts as a subprocess so we avoid top-level await in this config.
const repoRoot = path.resolve(__dirname, '..', '..');
execSync(`npx tsx ${path.join('scripts', 'generate-keys-to.ts')} ${keyRoot}`, {
  cwd: repoRoot,
  stdio: 'inherit',
});

process.env.E2E_BASE_URL = BASE_URL;
process.env.E2E_ADMIN_TOKEN = ADMIN_TOKEN;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: ['**/*.spec.ts'],
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  webServer: {
    command: `node ${path.resolve(__dirname, 'dist', 'index.js')}`,
    cwd: repoRoot,
    port: PORT,
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      ADMIN_TOKEN,
      PORT: String(PORT),
      DATA_ROOT: dataRoot,
      NOVA_KEY_DIR: keyRoot,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
