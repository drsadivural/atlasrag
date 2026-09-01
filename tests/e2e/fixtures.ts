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
/**
 * Reveals the email and password form on the sign-in screen.
 *
 * It is a disclosure that starts expanded on desktop and collapsed on a phone, where the
 * two federated buttons are what a small screen should lead with. A test that types into
 * it has to open it first, whichever viewport it is running at.
 */
export async function openCredentials(page: Page): Promise<void> {
  // Wait for the disclosure itself before asking whether the form is open. Checking too
  // early answers "not visible" because nothing has rendered yet, and the click that
  // follows then closes a panel that was already expanded.
  const toggle = page.getByRole('button', { name: /other approved access/i });
  await toggle.waitFor({ state: 'visible', timeout: 20_000 });

  const email = page.getByLabel('Government email');
  if (await email.isVisible().catch(() => false)) return;

  await toggle.click();
  await email.waitFor({ state: 'visible', timeout: 10_000 });
}

export async function signIn(
  page: Page,
  email = SEED_EMAIL,
  password = SEED_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await openCredentials(page);
  await page.getByLabel('Government email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in securely' }).click();
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
 * Picks a conversation from the past-consultations list.
 *
 * The list used to be a rail beside the workspace, and a drawer below 1280px; it is a tab
 * on the Activity page now, which is one list at every width. Going through the page
 * rather than a stored id is deliberate — it is the route a person takes, so the test
 * fails if that route breaks.
 */
export async function openConsultation(page: Page, name: RegExp): Promise<void> {
  await page.goto('/activity?tab=consultations');
  await waitForSettled(page);
  await page.getByRole('row', { name }).first().click();
  await page.waitForURL(/\/consult\/.+/, { timeout: 20_000 });
  await waitForSettled(page);
}

/**
 * Opens the consultation settings panel.
 *
 * It used to be a permanent rail on desktop and a drawer below 1280px, so the helper had
 * to guess which. It is one slide-over behind a gear at every width now, which is both
 * simpler to drive and the same thing every user sees.
 */
export async function openEvidencePanel(page: Page): Promise<void> {
  const panel = page.getByRole('dialog', { name: /consultation settings/i });
  if (await panel.isVisible().catch(() => false)) return;

  const gear = page.getByRole('button', { name: /consultation settings/i }).first();
  if (await gear.isVisible().catch(() => false)) {
    await gear.click();
    await panel.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  }
}

/**
 * Select an answer depth and wait for the answer to re-render at it.
 *
 * The choice is persisted per consultation, so a test that asserts on depth-specific
 * affordances — the inline citation chips only exist at the richer depths — has to set
 * the depth it needs rather than inherit whatever a previous run left behind.
 */
export async function setAnswerStyle(page: Page, name: RegExp): Promise<void> {
  await openEvidencePanel(page);
  const styles = page.getByRole('radiogroup', { name: /answer style/i }).first();
  if (!(await styles.isVisible().catch(() => false))) return;

  const option = styles.getByRole('radio', { name });
  if ((await option.getAttribute('aria-checked').catch(() => null)) !== 'true') {
    await option.click();
    await page.waitForTimeout(1200);
  }

  // Below 1280px the panel is a drawer over the conversation. Leaving it open would hide
  // the answer from whatever the caller does next, so put the page back as it was found.
  const drawer = page.getByRole('dialog').first();
  if (await drawer.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  }
}

export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    await signIn(page);
    await use(page);
  },
});

export { expect };
