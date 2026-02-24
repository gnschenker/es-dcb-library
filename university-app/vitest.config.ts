import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.unit.test.ts', 'tests/unit/**/*.test.ts'],
          testTimeout: 5000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts', 'tests/integration/**/*.test.ts'],
          testTimeout: 60000,
          // container-setup.ts starts the PostgreSQL testcontainer once per worker.
          // Using setupFiles (not globalSetup) because globalSetup env vars do not
          // propagate to forked workers in Vitest 3.2.x with inline projects.
          setupFiles: ['./tests/integration/container-setup.ts'],
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },
    ],
  },
});
