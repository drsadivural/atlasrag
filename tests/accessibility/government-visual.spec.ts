import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, waitForSettled } from '../e2e/fixtures.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = `${ROOT}/artifacts/screenshots/government`;

/**
 * Visual regression for the Government Edition sign-in screen.
 *
 * The reference pair lives in `artifacts/references/`. These captures are taken at the
 * viewport those references were authored at, plus the sizes the layout has to survive,
 * so a change in spacing, type, imagery or cropping is visible as a file diff rather than
 * being noticed by somebody months later.
 *
 * The whole matrix runs in one project: theme and language are page state, not browser
 * state, so multiplying the Playwright projects would only multiply the sign-in cost.
 */
test.describe('@visual government sign-in', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    await mkdir(OUT, { recursive: true });
  });

  test.skip(() => test.info().project.name !== 'desktop', 'the matrix sets its own viewports');

  const VIEWPORTS = [
    { name: '1680x945', width: 1680, height: 945 },
    { name: '1440x900', width: 1440, height: 900 },
    { name: '1024x768', width: 1024, height: 768 },
    { name: '768x1024', width: 768, height: 1024 },
    { name: '390x844', width: 390, height: 844 },
  ] as const;

  for (const viewport of VIEWPORTS) {
    // The reference pair was authored at 1680x945, so that size carries the full matrix;
    // the rest prove the layout holds rather than re-checking both languages.
    const matrix =
      viewport.name === '1680x945'
        ? ([
            ['light', 'en'],
            ['dark', 'en'],
            ['light', 'ar'],
            ['dark', 'ar'],
          ] as const)
        : ([
            ['light', 'en'],
            ['dark', 'en'],
          ] as const);

    for (const [theme, language] of matrix) {
      test(`${viewport.name} ${theme} ${language}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto('/login');
        await page.evaluate(() => localStorage.removeItem('uxe-preferences'));
        await page.evaluate(() => localStorage.removeItem('uxe-theme'));
        await page.reload();
        await waitForSettled(page);

        await page.getByRole('button', { name: /accessibility options/i }).click();
        await page
          .getByRole('dialog')
          .getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true })
          .click();
        await page.keyboard.press('Escape');

        if (language === 'ar') {
          await page.getByRole('button', { name: 'العربية' }).click();
          await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        }
        await waitForSettled(page);

        // Nothing may run off the side at any of these sizes.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, 'the page must not scroll sideways').toBeLessThanOrEqual(1);

        await page.screenshot({
          path: `${OUT}/login-${viewport.name}-${theme}-${language}.png`,
        });
      });
    }
  }
});
