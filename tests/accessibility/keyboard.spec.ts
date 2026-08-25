import {
  expect,
  openConsultation,
  openEvidencePanel,
  test,
  waitForSettled,
} from '../e2e/fixtures.js';

/**
 * Keyboard-only smoke tests.
 *
 * Axe cannot tell whether a page is *operable*; it can only tell whether the markup looks
 * right. These cases drive the product with the keyboard alone.
 */

test('the first tab stop is a skip link that reaches the main region', async ({ page }) => {
  await page.goto('/dashboard');
  await waitForSettled(page);

  await page.keyboard.press('Tab');
  const skip = page.locator(':focus');
  await expect(skip).toHaveText(/skip to (main )?content/i);

  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test('every navigation destination is reachable by keyboard', async ({ page }) => {
  await page.goto('/dashboard');
  await waitForSettled(page);

  // Desktop uses the persistent rail ("Main navigation"); below 768px the bottom bar
  // ("Primary navigation") is the one on screen. Whichever is visible must be operable.
  const nav = page
    .getByRole('navigation', { name: /Main navigation|Primary navigation/ })
    .filter({ visible: true })
    .first();

  const links = await nav.getByRole('link').all();
  expect(links.length).toBeGreaterThan(3);

  for (const link of links) {
    await link.focus();
    await expect(link).toBeFocused();
  }
});

test('the answer-style control is operable with the arrow keys', async ({ page }) => {
  await page.goto('/consult');
  await waitForSettled(page);

  // The control lives in the Evidence & Output panel of an open consultation, which is a
  // drawer below 1280px. Opening it here keeps the test from skipping itself.
  await openConsultation(page, /UAE Fire Code Review/);
  await openEvidencePanel(page);

  const group = page.getByRole('radiogroup', { name: /answer style/i }).first();
  await expect(group).toBeVisible();

  const selected = group.getByRole('radio', { checked: true });
  const before = await selected.textContent();

  await selected.focus();
  await page.keyboard.press('ArrowRight');

  const after = await group.getByRole('radio', { checked: true }).textContent();
  expect(after).not.toBe(before);
});

test('a citation can be opened and dismissed without a mouse', async ({ page }) => {
  await page.goto('/consult');
  await waitForSettled(page);
  await openConsultation(page, /UAE Fire Code Review/);

  // "View all citations" is present at every answer depth, unlike the inline chips, so the
  // test does not depend on which depth a previous case happened to leave selected.
  const openEvidence = page.getByRole('button', { name: /view all citations/i }).first();
  await openEvidence.scrollIntoViewIfNeeded();
  await expect(openEvidence).toBeVisible();

  await openEvidence.focus();
  await page.keyboard.press('Enter');

  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a form reports its errors to the keyboard user, not only in colour', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const email = page.getByLabel('Work email');
    // The browser's own constraint validation or the app's — either way the field must be
    // marked invalid programmatically.
    const invalid = await email.evaluate(
      (node) => node.matches(':invalid') || node.getAttribute('aria-invalid') === 'true',
    );
    expect(invalid).toBe(true);
  });
});

test('focus is visible on every interactive element it lands on', async ({ page }) => {
  await page.goto('/knowledge');
  await waitForSettled(page);

  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
        boxShadow: style.boxShadow,
        tag: element.tagName,
      };
    });
    if (!outline) continue;

    const hasIndicator =
      (outline.outlineStyle !== 'none' && parseFloat(outline.outlineWidth) > 0) ||
      (outline.boxShadow !== 'none' && outline.boxShadow.length > 0);
    expect(hasIndicator, `no focus indicator on <${outline.tag.toLowerCase()}>`).toBe(true);
  }
});
