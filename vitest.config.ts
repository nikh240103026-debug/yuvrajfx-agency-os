import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each test file gets its own throwaway SQLite database, so files can run in parallel.
    pool: 'forks',
    testTimeout: 20_000,
  },
});
