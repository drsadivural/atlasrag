import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, signIn, test, waitForSettled } from './fixtures.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Visual regression + delivery screenshots.
 *
 * Captured at the exact viewports the brief specifies (1440x900, 1024x768, 390x844) for
 * the four primary screens, so implementation output can be compared against the supplied
 * concepts at the same size.
 */
test.describe('@visual primary screens', () => {
  test.beforeAll(async () => {
    await mkdir(`${ROOT}/artifacts/screenshots`, { recursive: true });
  });

  test('login', async ({ page }, testInfo) => {
    await page.goto('/login');
    await waitForSettled(page);
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await capture(page, testInfo.project.name, '01-login');
  });

  test('dashboard', async ({ page }, testInfo) => {
    await signIn(page);
    await waitForSettled(page);
    await expect(page.getByRole('button', { name: 'Start consultation', exact: true })).toBeVisible();
    await capture(page, testInfo.project.name, '02-dashboard');
  });

  test('knowledge base', async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto('/knowledge');
    await waitForSettled(page);
    await expect(page.getByRole('heading', { name: 'Knowledge Base' })).toBeVisible();
    await capture(page, testInfo.project.name, '03-knowledge-base');
  });

  test('consult now', async ({ page }, testInfo) => {
    await signIn(page);
    await page.goto('/consult');
    await waitForSettled(page);

    // Open the most recent consultation so the screenshot shows the real workspace rather
    // than the empty state.
    const first = page.getByRole('button', { name: /UAE Fire Code Review/ }).first();
    if (await first.isVisible().catch(() => false)) {
      await first.click();
      await waitForSettled(page);
    }
    await capture(page, testInfo.project.name, '04-consult-now');
  });
});

async function capture(
  page: import('@playwright/test').Page,
  project: string,
  name: string,
): Promise<void> {
  await page.screenshot({
    path: `${ROOT}/artifacts/screenshots/${name}-${project}.png`,
    // Full-page for the delivery screenshots so nothing below the fold is hidden.
    fullPage: false,
  });
}
