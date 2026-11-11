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
          exclude: ['packages/db-local/**', 'apps/hub/**', '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          name: 'sqlite-hub',
          globals: true,
          environment: 'node',
          include: ['packages/db-local/**/*.test.ts', 'apps/hub/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
