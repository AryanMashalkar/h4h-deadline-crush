import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', ALLOW_PRIVATE_LINKS: 'true', DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/crush_test' },
  },
});
