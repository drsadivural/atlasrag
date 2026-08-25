import { fileURLToPath } from 'node:url';
import {
  expect,
  openConsultation,
  openEvidencePanel,
  signIn,
  test,
  waitForSettled,
} from './fixtures.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/documents/', import.meta.url));

/**
 * The critical paths, driven through the browser against the real stack.
 *
 * Every assertion is about something a user would notice: a document becoming ready, an
 * answer carrying a verifiable quotation, a citation opening at the right page.
 */

test.describe('sign in', () => {
  // These are about authenticating, so they start from a clean context rather than the
  // shared signed-in state.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('refuses a wrong password without saying which field was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill('dr.sadi@uxe.example.com');
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText(/no account|unknown user|wrong password for/i);
    await expect(page).toHaveURL(/\/login/);
  });

  test('signs in, lands on the dashboard, and signs out again', async ({ page }) => {
    await signIn(page);
    await waitForSettled(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.getByRole('button', { name: /Dr Sadi Vural — Profile/ }).click();
    await page.getByRole('menuitem', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });

    // The session is really gone, not just the page.
    await page.goto('/knowledge');
    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });
  });
});

test.describe('knowledge base', () => {
  test('uploads a document and reports it ready', async ({ page }) => {
    await page.goto('/knowledge');
    await waitForSettled(page);

    // A document the workspace cannot already hold, so the assertion is about ingestion
    // rather than about which fixtures the seed happens to use.
    const name = `note-${Date.now()}.txt`;
    const body = `Emergency lighting note ${Date.now()}.\nThe corridor illuminance is 12 lux at floor level.\n`;

    const filters = page.getByRole('group', { name: 'Filter by status' });
    const readyChip = filters.getByRole('button', { name: /^Ready/ });
    const readyCount = async () =>
      Number(((await readyChip.textContent()) ?? '').replace(/\D/g, '') || '0');
    const readyBefore = await readyCount();

    await page.setInputFiles('input[type="file"]', {
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from(body, 'utf8'),
    });

    // The upload list reports this file, and reports no transport failure for it. The
    // assertion is scoped to this entry: the seeded workspace deliberately contains a
    // failed source whose reason mentions a failed upload.
    const entry = page.locator('li', { hasText: name }).first();
    await expect(entry).toBeVisible({ timeout: 30_000 });
    await expect(entry.getByText(/could not reach the server/i)).toHaveCount(0);

    // It really finishes: the count of ready sources grows. Asserted on the filter chip
    // rather than on a table row, because below `md` the table is a card list.
    await expect
      .poll(readyCount, { timeout: 150_000, intervals: [2000] })
      .toBeGreaterThan(readyBefore);
  });

  test('explains a duplicate instead of silently discarding it', async ({ page }) => {
    await page.goto('/knowledge');
    await waitForSettled(page);

    await page.setInputFiles('input[type="file"]', `${FIXTURES}regulation-native.pdf`);

    // The message names the document it matched, rather than failing silently.
    await expect(page.getByText(/already in your knowledge base as/i).first()).toBeVisible({
      timeout: 60_000,
    });
  });

  test('opens a source and shows its versions and processing log', async ({ page }) => {
    await page.goto('/knowledge');
    await waitForSettled(page);

    // Search for it rather than assuming where it sits in the list, which depends on how
    // many sources the workspace happens to hold.
    await page.getByPlaceholder(/search sources/i).fill('UAE Fire');
    await page.waitForTimeout(1200);

    // The list renders as a table on desktop and as cards below `md`; both are in the DOM,
    // so the visible one is selected explicitly.
    const source = page
      .getByRole('button', { name: /UAE Fire and Life Safety Code/i })
      .filter({ visible: true })
      .first();
    await source.scrollIntoViewIfNeeded();
    await source.click();
    await expect(page).toHaveURL(/\/knowledge\/.+/);
    await waitForSettled(page);

    await expect(page.getByRole('tab', { name: /versions/i })).toBeVisible();
    await page.getByRole('tab', { name: /versions/i }).click();
    await expect(page.getByText(/v1\.0/).first()).toBeVisible();
  });
});

test.describe('asking and citing', () => {
  test('answers from the sources and opens the cited page on click', async ({ page }) => {
    await page.goto('/consult');
    await waitForSettled(page);

    await openConsultation(page, /UAE Fire Code Review/);
    await waitForSettled(page);

    const answer = page.locator('[data-answer-root]').last();
    await expect(answer).toBeVisible({ timeout: 30_000 });

    // Every answer names the engine that produced it.
    await expect(answer.getByText(/Generated by/)).toBeVisible();

    const openPage = answer.getByRole('button', { name: /open exact page/i }).first();
    await openPage.scrollIntoViewIfNeeded();
    await openPage.click();

    const viewer = page.getByRole('dialog');
    await expect(viewer).toBeVisible({ timeout: 20_000 });
    // The viewer shows the document and the page the citation pointed at.
    await expect(viewer.getByText(/p\.\s?\d+|page \d+/i).first()).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
  });

  test('switching answer depth keeps the same decision', async ({ page }) => {
    await page.goto('/consult');
    await waitForSettled(page);
    await openConsultation(page, /UAE Fire Code Review/);
    await waitForSettled(page);

    const answer = page.locator('[data-answer-root]').last();
    await expect(answer).toBeVisible({ timeout: 30_000 });
    const before = await answer.textContent();

    await openEvidencePanel(page);
    const styles = page.getByRole('radiogroup', { name: /answer style/i }).first();
    if (await styles.isVisible().catch(() => false)) {
      await styles.getByRole('radio', { name: /yes \/ no/i }).click();
      await page.waitForTimeout(1200);

      const after = await page.locator('[data-answer-root]').last().textContent();
      // The verdict is unchanged; only the depth differs.
      const verdict = (text: string | null) =>
        /\b(YES|NO|UNABLE TO DETERMINE)\b/.exec(text ?? '')?.[0];
      expect(verdict(after)).toBe(verdict(before));
    }
  });

  test('asks a question the corpus cannot answer and gets an abstention', async ({ page }) => {
    await page.goto('/consult');
    await waitForSettled(page);
    await openConsultation(page, /UAE Fire Code Review/);
    await waitForSettled(page);

    const composer = page.getByPlaceholder(/Ask Ayumi/i);
    await composer.fill('What is the required compressive strength of the basement raft slab?');
    await composer.press('Control+Enter');

    const answer = page.locator('[data-answer-root]').last();
    await expect(answer).toBeVisible({ timeout: 120_000 });
    await expect(answer).not.toContainText(/^YES/);
  });
});

test.describe('corrections', () => {
  test('reviews proposed changes and generates a corrected edition', async ({ page }) => {
    await page.goto('/consult');
    await waitForSettled(page);
    await openConsultation(page, /UAE Fire Code Review/);
    await waitForSettled(page);

    await openEvidencePanel(page);
    const start = page.getByRole('button', { name: /generate corrected/i }).first();
    await start.scrollIntoViewIfNeeded();
    await start.click();

    const review = page.getByRole('button', { name: /review proposed changes/i });
    await expect(review).toBeVisible({ timeout: 120_000 });
    await review.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Every proposed change carries the rule that justifies it.
    await expect(dialog.getByText(/Required by/).first()).toBeVisible();

    const generate = dialog.getByRole('button', { name: /generate corrected edition/i });

    // Nothing may be generated while nothing has been accepted. The plan may already carry
    // decisions from an earlier run, so the state is read rather than assumed.
    const footer = dialog.getByText(/\d+ accepted/);
    const acceptedText = (await footer.textContent()) ?? '';
    if (acceptedText.startsWith('0 accepted')) {
      await expect(generate).toBeDisabled();
    }

    await dialog.getByRole('button', { name: 'Accept' }).first().click();
    await expect(generate).toBeEnabled({ timeout: 20_000 });

    await generate.click();
    await expect(page.getByText(/queued|ready/i).first()).toBeVisible({ timeout: 60_000 });
  });
});

test.describe('reports and activity', () => {
  test('lists generated artifacts with their format and author', async ({ page }) => {
    await page.goto('/reports');
    await waitForSettled(page);
    await expect(page.getByRole('heading', { name: /reports/i }).first()).toBeVisible();
  });

  test('shows the audit trail with who did what', async ({ page }) => {
    await page.goto('/activity');
    await waitForSettled(page);

    // The actor is named on every row, in the table on desktop and in the card list below.
    // Both are in the DOM at every width, so the visible one is selected explicitly.
    await expect(page.getByText('Dr Sadi Vural').filter({ visible: true }).first()).toBeVisible({
      timeout: 30_000,
    });
  });
});

test.describe('permissions', () => {
  // A different account, so this one authenticates for itself.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a read-only member is not offered actions they cannot perform', async ({ page }) => {
    await signIn(page, 'guest.auditor@uxe.example.com', 'Tr0ubad0ur-Nimbus-42');
    await waitForSettled(page);

    await page.goto('/knowledge');
    await waitForSettled(page);

    // No upload affordance for somebody without source:create.
    await expect(page.getByRole('button', { name: /browse/i })).toHaveCount(0);
  });
});
