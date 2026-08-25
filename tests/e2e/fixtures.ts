import { test as base, expect, type Page } from '@playwright/test';

import { fileURLToPath } from 'node:url';

/** Where the shared signed-in state lives; written once by `auth.setup.ts`. */
export const STORAGE_STATE = fileURLToPath(
  new URL('../../artifacts/.auth/user.json', import.meta.url),
);

export const SEED_EMAIL = process.env.SEED_EMAIL ?? 'dr.sadi@uxe.example.com';
export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Tr0ubad0ur-Nimbus-42';

/**
 * Signs in through the real form.
 *
 * Deliberately not a shortcut that stuffs a cookie: sign-in is one of the acceptance
 * scenarios, so exercising it on every test keeps it covered continuously rather than in
 * one isolated case.
 */
export async function signIn(
  page: Page,
  email = SEED_EMAIL,
  password = SEED_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

/**
 * Waits for the page to settle: no skeletons, no pending status regions.
 *
 * Screenshotting mid-load is the usual cause of flaky visual diffs, and asserting against
 * a half-rendered page is worse than not asserting at all.
 */
export async function waitForSettled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  // Let CSS transitions finish so a screenshot is not caught mid-fade.
  await page.waitForTimeout(350);
}

/**
 * Opens the consultation history and picks a conversation.
 *
 * Below 1280px the history is an off-canvas drawer, so a test that clicks straight at the
 * list would only pass on desktop — and would say nothing about whether the other layouts
 * work.
 */
export async function openConsultation(page: Page, name: RegExp): Promise<void> {
  const item = page.getByRole('button', { name });
  if (
    !(await item
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    const history = page.getByRole('button', { name: /consultations|history/i }).first();
    if (await history.isVisible().catch(() => false)) {
      await history.click();
      await page.waitForTimeout(500);
    }
  }
  await item.first().click();

  // Below 1280px the list is a drawer that closes itself on selection; wait for it to go
  // so the conversation underneath is what the test interacts with.
  await page
    .getByRole('dialog', { name: /consultations/i })
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
}

/** Opens the Evidence & Output panel, which is a drawer below 1280px. */
export async function openEvidencePanel(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { name: /evidence & output/i }).first();
  if (await heading.isVisible().catch(() => false)) return;

  const toggle = page.getByRole('button', { name: /evidence|output/i }).first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(600);
  }
}

export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    await signIn(page);
    await use(page);
  },
});

export { expect };
