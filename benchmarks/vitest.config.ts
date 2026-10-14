import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['benchmarks/run.ts'],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    globalSetup: ['tests/integration/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
