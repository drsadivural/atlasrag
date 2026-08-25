import AxeBuilder from '@axe-core/playwright';
import { expect, signIn, test, waitForSettled } from '../e2e/fixtures.js';
import type { Page } from '@playwright/test';

/**
 * WCAG 2.2 AA scans.
 *
 * The tag set is the standard the brief names. Nothing is excluded and no rule is
 * disabled: a violation here is a real defect, not a configuration to tune.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(TAGS).analyze();
}

function describeViolations(results: Awaited<ReturnType<typeof scan>>): string {
  return results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes
          .slice(0, 4)
          .map((node) => `    ${node.target.join(' ')}\n      ${node.failureSummary ?? ''}`)
          .join('\n'),
    )
    .join('\n\n');
}

test.describe('unauthenticated pages', () => {
  for (const [name, path] of [
    ['sign in', '/login'],
    ['register', '/register'],
    ['forgot password', '/forgot-password'],
  ] as const) {
    test(`${name} has no WCAG 2.2 AA violations`, async ({ page }) => {
      await page.goto(path);
      await waitForSettled(page);
      const results = await scan(page);
      expect(results.violations, describeViolations(results)).toEqual([]);
    });
  }
});

test.describe('authenticated pages', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  for (const [name, path] of [
    ['dashboard', '/dashboard'],
    ['consult', '/consult'],
    ['knowledge base', '/knowledge'],
    ['reports', '/reports'],
    ['activity', '/activity'],
    ['users', '/users'],
    ['settings', '/settings/general'],
  ] as const) {
    test(`${name} has no WCAG 2.2 AA violations`, async ({ page }) => {
      await page.goto(path);
      await waitForSettled(page);
      const results = await scan(page);
      expect(results.violations, describeViolations(results)).toEqual([]);
    });
  }

  test('an answer with its evidence has no violations', async ({ page }) => {
    await page.goto('/consult');
    await waitForSettled(page);

    const firstConsultation = page
      .getByRole('button', { name: /compliance|review|consultation/i })
      .first();
    if (await firstConsultation.isVisible().catch(() => false)) {
      await firstConsultation.click();
      await waitForSettled(page);
    }

    const results = await scan(page);
    expect(results.violations, describeViolations(results)).toEqual([]);
  });

  test('an open dialog has no violations and traps focus', async ({ page }) => {
    await page.goto('/knowledge');
    await waitForSettled(page);

    const addUrl = page.getByRole('button', { name: /website url/i });
    if (await addUrl.isVisible().catch(() => false)) {
      await addUrl.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      const results = await scan(page);
      expect(results.violations, describeViolations(results)).toEqual([]);

      // Focus must be inside the dialog, not left on the page behind it.
      const focusInside = await dialog.evaluate((node) => node.contains(document.activeElement));
      expect(focusInside).toBe(true);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });
});
