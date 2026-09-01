import AxeBuilder from '@axe-core/playwright';
import { expect, test, waitForSettled } from '../e2e/fixtures.js';
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
  // These pages are only reachable signed out.
  test.use({ storageState: { cookies: [], origins: [] } });

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

/**
 * The sign-in screen in every combination it actually ships in.
 *
 * One page, four renderings. A contrast mistake that only exists in the dark theme, or a
 * label that only breaks under RTL, would pass a single scan of the default and reach
 * everybody who does not use the default.
 */
test.describe('the sign-in screen in both themes and both languages', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const theme of ['light', 'dark'] as const) {
    for (const language of ['en', 'ar'] as const) {
      test(`${theme} ${language} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await page.goto('/login');
        // From the defaults, so a case that failed before this one cannot change what it
        // scans.
        await page.evaluate(() => localStorage.removeItem('uxe-preferences'));
        await page.evaluate(() => localStorage.removeItem('uxe-theme'));
        await page.reload();
        await waitForSettled(page);

        await page.getByRole('button', { name: /accessibility options/i }).click();
        const dialog = page.getByRole('dialog');
        await dialog
          .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
          .click();
        await page.keyboard.press('Escape');

        if (language === 'ar') {
          await page.getByRole('button', { name: 'العربية' }).click();
          await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        }
        await waitForSettled(page);

        const results = await scan(page);
        expect(results.violations, describeViolations(results)).toEqual([]);

        // Leave the next case the defaults rather than this one's choices.
        await page
          .getByRole('button', { name: /accessibility options|خيارات إمكانية الوصول/i })
          .click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: /reset accessibility|إعادة تعيين/i })
          .click();
        await page.keyboard.press('Escape');
      });
    }
  }
});

test.describe('authenticated pages', () => {
  for (const [name, path] of [
    ['dashboard', '/dashboard'],
    ['consult', '/consult'],
    ['knowledge base', '/settings/knowledge'],
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
    await page.goto('/settings/knowledge');
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
