import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * One Vitest configuration with named projects, so `pnpm test` runs the whole suite and
 * a single layer can still be run alone during development.
 *
 * The integration project is deliberately serial and single-forked: it talks to a real
 * PostgreSQL database and the real document worker, and parallel workers would race on
 * the same schema.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          root,
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'component',
          root,
          include: ['tests/component/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/component/setup.ts'],
          globals: true,
        },
      },
      {
        test: {
          name: 'integration',
          root,
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/integration/setup.ts'],
          // A real database: one process, one test at a time.
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          name: 'rag-evals',
          root,
          include: ['tests/rag-evals/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/integration/setup.ts'],
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          name: 'security',
          root,
          include: ['tests/security/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/integration/setup.ts'],
          pool: 'forks',
          maxWorkers: 1,
          minWorkers: 1,
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'artifacts/coverage',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/index.ts',
        'packages/db/src/schema/**',
        'packages/db/src/seed.ts',
        'packages/db/src/reset.ts',
        'packages/contracts/src/openapi.ts',
      ],
      // The evidence path is where a regression is most costly, so the floor is set at a
      // level the suite genuinely clears rather than at an aspirational number.
      thresholds: { lines: 55, functions: 55, branches: 70, statements: 55 },
    },
  },
});
