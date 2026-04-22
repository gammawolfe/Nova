import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['test/public/**', 'jsdom'],
    ],
    include: ['test/public/**/*.test.js', 'test/server/**/*.test.ts'],
    globals: true,
  },
});
