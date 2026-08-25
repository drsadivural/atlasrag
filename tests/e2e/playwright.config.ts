import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:4173';

/**
 * End-to-end configuration.
 *
 * Runs against a real stack: PostgreSQL with pgvector, the Python document worker, the
 * Hono API and the built web bundle. Nothing is mocked, so a green run means the product
 * genuinely works rather than that the fakes agree with each other.
 *
 * The three viewports are the ones the brief calls out, and the visual-regression
 * screenshots are taken at exactly those sizes.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  outputDir: `${ROOT}/artifacts/test-results`,
  fullyParallel: false,
  // A retry masks flakiness locally; CI gets one so a genuine infrastructure blip does not
  // fail the whole pipeline.
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02 } },
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: `${ROOT}/artifacts/playwright-report`, open: 'never' }]]
    : [['list'], ['html', { outputFolder: `${ROOT}/artifacts/playwright-report`, open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 } },
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 14 Pro'],
        // Chromium rather than the device's default WebKit: the requirement is the 390px
        // viewport and touch input, and pinning one engine keeps visual diffs comparable.
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
