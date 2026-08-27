import { expect, test, waitForSettled } from './fixtures.js';

/**
 * Getting an answer back.
 *
 * The stream is the fast path, and this is what makes it safe for the stream to miss
 * something: with the connection blocked outright the answer still has to arrive, because
 * the screen falls back to asking. A screen that can only be updated by a socket is a
 * screen that stops forever when the socket does.
 */
test.describe('asking a question', () => {
  test('answers even when the live stream never connects', async ({ page }) => {
    await page.route('**/stream', (route) => route.abort());

    await page.goto('/consult');
    await waitForSettled(page);
    await page
      .getByRole('button', { name: /new consultation/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/consult\/[A-Z0-9]+/i, { timeout: 20_000 });

    const composer = page.getByPlaceholder(/Ask Ayumi/i);
    await composer.fill('What does the code require for emergency lighting?');
    // Cmd/Ctrl+Enter sends; plain Enter is a newline, because these are long questions.
    await composer.press('Control+Enter');

    await expect(page.locator('[data-answer-root]')).toHaveCount(1, { timeout: 45_000 });
    await expect(page.getByText(/reviewing your sources/i)).toHaveCount(0);
  });

  test('says a consultation has nothing in scope before the question is asked', async ({
    page,
  }) => {
    await page.goto('/consult');
    await waitForSettled(page);
    await page
      .getByRole('button', { name: /new consultation/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/consult\/[A-Z0-9]+/i, { timeout: 20_000 });

    // With nothing selected the answer could only ever be "unable to determine", which is
    // a poor way to find out. The warning belongs where it can still be acted on.
    await expect(page.getByText(/No sources are selected/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /open the knowledge base/i })).toBeVisible();
  });
});
