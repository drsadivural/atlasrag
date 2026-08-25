import { test as base, expect, type Page } from '@playwright/test';

export const SEED_EMAIL = process.env.SEED_EMAIL ?? 'dr.sadi@uxe.example.com';
export const SEED_PASSWORD = process.env.SEED_PASSWORD ?? 'Tr0ubad0ur-Nimbus-42';

/**
 * Signs in through the real form.
 *
 * Deliberately not a shortcut that stuffs a cookie: sign-in is one of the acceptance
 * scenarios, so exercising it on every test keeps it covered continuously rather than in
 * one isolated case.
 */
export async function signIn(page: Page, email = SEED_EMAIL, password = SEED_PASSWORD): Promise<void> {
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

export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    await signIn(page);
    await use(page);
  },
});

export { expect };
