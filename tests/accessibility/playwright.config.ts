import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from '../e2e/fixtures.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:4173';

/**
 * Accessibility configuration.
 *
 * Separate from the E2E project so a11y can be run alone in review, and so its failures
 * read as accessibility failures rather than as functional ones. Desktop and mobile are
 * both covered: the mobile layout has its own navigation and its own focus order.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  outputDir: `${ROOT}/artifacts/a11y-results`,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: `${ROOT}/artifacts/a11y-report`, open: 'never' }]]
    : [['list'], ['html', { outputFolder: `${ROOT}/artifacts/a11y-report`, open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // Signs in once, for the same reason the E2E suite does: authentication is rate
    // limited per IP and re-authenticating per test would trip it.
    { name: 'setup', testMatch: /auth\.setup\.ts/, testDir: '../e2e' },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: STORAGE_STATE,
      },
    },
    {
      name: 'mobile',
      dependencies: ['setup'],
      use: {
        ...devices['iPhone 14 Pro'],
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        storageState: STORAGE_STATE,
      },
    },
  ],
});
