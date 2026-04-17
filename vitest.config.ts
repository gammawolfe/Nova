import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.worktrees/**',
      // Admin UI browser-side tests run under jsdom via their own workspace config.
      'packages/admin-api/test/public/**',
      // Playwright specs run via `npm run test:e2e`, not Vitest.
      'packages/admin-api/test/e2e/**',
    ],
  },
});
