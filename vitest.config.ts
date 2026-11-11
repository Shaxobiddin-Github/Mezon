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
            'apps/hub/**',
            '**/node_modules/**',
            '**/dist/**',
          ],
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
          exclude: ['**/*.perf.test.ts', '**/node_modules/**', '**/dist/**'],
          maxWorkers: 4,
          testTimeout: 30_000,
          hookTimeout: 30_000,
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
