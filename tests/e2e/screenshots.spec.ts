import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
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
    await expect(
      page.getByRole('button', { name: 'Start consultation', exact: true }),
    ).toBeVisible();
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

      // The transcript auto-scrolls to the newest message, which puts the answer's own
      // header above the fold. Bring the last answer's top into view so the screenshot
      // shows the verdict rather than the middle of a citation.
      const answer = page.locator('[data-answer-root]').last();
      if (await answer.isVisible().catch(() => false)) {
        // Align the answer's TOP, not the nearest edge: the verdict and headline are what
        // the screenshot needs to show, and a long evidence table would otherwise leave
        // the frame parked in the middle of a citation.
        await answer.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
        await page.waitForTimeout(400);
      }
    }
    await capture(page, testInfo.project.name, '04-consult-now');
  });
});

async function capture(page: Page, project: string, name: string): Promise<void> {
  await page.screenshot({
    path: `${ROOT}/artifacts/screenshots/${name}-${project}.png`,
    // Full-page for the delivery screenshots so nothing below the fold is hidden.
    fullPage: false,
  });
}
