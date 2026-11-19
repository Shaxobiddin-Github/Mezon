import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
          exclude: [
            '**/*.perf.test.ts',
            'packages/db-local/**',
            'packages/db-cloud/**',
            'apps/cloud/**',
            'apps/hub/**',
            '**/node_modules/**',
            '**/dist/**',
          ],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          sequence: {
            groupOrder: 0,
          },
        },
      },
      {
        test: {
          name: 'sqlite-hub',
          globals: true,
          environment: 'node',
          include: ['packages/db-local/**/*.test.ts', 'apps/hub/**/*.test.ts'],
          exclude: [
            '**/*.perf.test.ts',
            'apps/hub/src/hub-cloud-sync.integration.test.ts',
            'apps/hub/src/hub-cloud-e2e.integration.test.ts',
            'apps/hub/src/sync-two-hubs.test.ts',
            '**/node_modules/**',
            '**/dist/**',
          ],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          sequence: {
            groupOrder: 0,
          },
        },
      },
      {
        test: {
          name: 'pg-cloud',
          globals: true,
          environment: 'node',
          include: [
            'packages/db-cloud/**/*.test.ts',
            'apps/cloud/**/*.test.ts',
            'apps/hub/src/hub-cloud-sync.integration.test.ts',
            'apps/hub/src/hub-cloud-e2e.integration.test.ts',
            'apps/hub/src/sync-two-hubs.test.ts',
          ],
          exclude: ['**/*.perf.test.ts', '**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          sequence: {
            groupOrder: 1,
          },
        },
      },
      {
        test: {
          name: 'perf',
          globals: true,
          environment: 'node',
          include: ['packages/**/*.perf.test.ts', 'apps/**/*.perf.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60_000,
          hookTimeout: 30_000,
          sequence: {
            groupOrder: 2,
          },
        },
      },
    ],
  },
});
