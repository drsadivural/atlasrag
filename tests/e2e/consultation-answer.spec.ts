import { expect, openConsultation, openEvidencePanel, test, waitForSettled } from './fixtures.js';

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

/**
 * A refresh that fails is not a page that failed.
 *
 * The view polls itself while an answer is being produced, and refetches whenever a
 * question is sent. When one of those reads came back an error — a 429 from the per-user
 * budget was enough — the whole workspace was replaced by "Something went wrong", taking a
 * finished answer, its citations and the correction controls off the screen with it. The
 * content is still good; only the refresh failed, and that is what the user should be
 * told, without losing what they were reading.
 */
test('keeps the conversation on screen when a background refresh fails', async ({ page }) => {
  await page.goto('/consult');
  await waitForSettled(page);
  await page
    .getByRole('button', { name: /new consultation/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/consult\/[A-Z0-9]+/i, { timeout: 20_000 });

  const composer = page.getByPlaceholder(/Ask Ayumi/i);
  await expect(composer).toBeVisible();

  // Reads of this consultation only, and only from here: the first load has to succeed or
  // there would be nothing on screen to preserve. The single-segment glob leaves the
  // nested /messages and /stream paths alone, so sending still works.
  await page.route('**/api/v1/consultations/*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 429,
      contentType: 'application/json',
      headers: { 'retry-after': '30' },
      body: JSON.stringify({
        error: { code: 'rate_limited', message: 'Too many requests. Please slow down.' },
      }),
    });
  });

  /*
   * Each send refetches the conversation, and every one of those reads now fails. The gap
   * between them is deliberate: what puts the strip up is the content on screen falling
   * measurably behind, not a tally of attempts, so the second failure has to land far
   * enough past the last good read to qualify.
   */
  for (const question of [
    'What does the code require for emergency lighting?',
    'And for signage?',
  ]) {
    await composer.fill(question);
    await composer.press('Control+Enter');
    await expect(composer).toHaveValue('');
    await page.waitForTimeout(5_000);
  }

  await expect(page.getByText(/Live updates paused/i)).toBeVisible({ timeout: 30_000 });

  // The composer belongs to the workspace: had the error state taken over, it would be gone.
  await expect(composer).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
});

/**
 * Changing your mind faster than the network.
 *
 * Each control in the evidence panel saved by asking the server to re-read the
 * consultation afterwards. Two changes inside one round trip turned that into a race the
 * user lost: the re-read fired by the first change was still in flight when the second
 * one asked for its own, React Query folded the second request into the first, and the
 * answer that came back had been read before the second change was committed. The panel
 * snapped back to the earlier choice and stayed there — the save had worked, the picture
 * of it was stale.
 *
 * Saves are chained now and seeded from what the write itself returns, so there is no
 * second read to lose a race with.
 */
test('keeps the second of two preference changes made in quick succession', async ({ page }) => {
  await page.goto('/consult');
  await waitForSettled(page);
  await openConsultation(page, /UAE Fire Code Review/);
  await openEvidencePanel(page);

  const group = page.getByRole('radiogroup', { name: /answer style/i }).first();
  await expect(group).toBeVisible();

  const original = (await group.getByRole('radio', { checked: true }).textContent()) ?? '';
  const names = (await group.getByRole('radio').allTextContents()).filter((n) => n !== original);
  const [first, second] = names;
  // Two changes are the whole point, so say so plainly rather than failing later on an
  // undefined selector name.
  if (!first || !second)
    throw new Error(`answer style offers too few options: ${names.join(', ')}`);

  // Reads held open, writes left alone. On a fast connection the re-read finishes between
  // two clicks and the race never happens; two seconds is what a phone on a slow link
  // gives you for free, and it is the window this test is about.
  await page.route('**/api/v1/consultations/*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return route.fallback();
  });

  await group.getByRole('radio', { name: first, exact: true }).click();
  await group.getByRole('radio', { name: second, exact: true }).click();

  await expect(group.getByRole('radio', { checked: true })).toHaveText(second, { timeout: 20_000 });
  await expect(page.getByText('Could not save')).toHaveCount(0);

  // The depth is stored server-side, so leave it as it was found.
  await page.unroute('**/api/v1/consultations/*');
  await group.getByRole('radio', { name: original, exact: true }).click();
  await expect(group.getByRole('radio', { checked: true })).toHaveText(original, {
    timeout: 20_000,
  });
});
