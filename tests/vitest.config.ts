import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    include: ['integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
