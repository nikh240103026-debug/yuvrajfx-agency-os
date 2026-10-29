import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Tests require TEST_DATABASE_URL pointing to a disposable PostgreSQL database named yuvraj_agency_test.
    pool: 'forks',
    testTimeout: 20_000,
  },
});
