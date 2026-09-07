import type { Page } from '@playwright/test';
import { expect, test, waitForSettled } from './fixtures.js';

/**
 * Removing a consultation from the list.
 *
 * Both controls live in a menu inside a table row, and both open a dialog. Radix portals
 * each of those out of the row in the DOM, but React sends events up the component tree
 * rather than the document tree — so choosing "Move to archive", and then confirming it,
 * both reached the row's own click handler and opened the consultation. On a draft that
 * looks exactly like being dumped into a brand new one, and the archive that had in fact
 * just succeeded was nowhere to be seen.
 */
test.describe('removing a consultation', () => {
  async function openRowMenu(page: Page) {
    await page.goto('/activity?tab=consultations');
    await waitForSettled(page);
    await page
      .getByRole('button', { name: /^Actions for/ })
      .first()
      .click();
  }

  test('archiving from the row menu stays on the list', async ({ page }) => {
    await openRowMenu(page);
    await page.getByRole('menuitem', { name: /move to archive/i }).click();

    // Choosing the action must not navigate.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain('/activity');

    // Nor must confirming it.
    await page
      .getByRole('button', { name: /move to archive/i })
      .last()
      .click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
    expect(page.url()).toContain('/activity');
  });

  test('offers a permanent delete alongside the archive, and warns that it is final', async ({
    page,
  }) => {
    await openRowMenu(page);
    const permanently = page.getByRole('menuitem', { name: /delete permanently/i });
    await expect(permanently).toBeVisible();
    await permanently.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // Archiving is reversible and this is not; the dialog has to say which one this is.
    await expect(dialog).toContainText(/cannot be undone/i);
    expect(page.url()).toContain('/activity');
  });
});
