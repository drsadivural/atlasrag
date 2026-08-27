import { expect, openCredentials, test, waitForSettled } from '../e2e/fixtures.js';

/**
 * The Government Edition sign-in screen, driven in a browser.
 *
 * Everything here is a state the approved references or the requirements call for and
 * that only a real browser can prove: a language that turns the page round, a preference
 * that survives a reload, a provider that is honest about not being configured, and a
 * screen somebody can get through with a keyboard alone.
 */

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Start every case from the defaults.
 *
 * These preferences persist by design, and several cases change them. Clearing at the
 * start rather than tidying up at the end means a case that fails midway cannot decide
 * what the next one sees.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await page.evaluate(() => localStorage.removeItem('uxe-preferences'));
  await page.evaluate(() => localStorage.removeItem('uxe-theme'));
});

test('leads with UAE PASS, whichever way accounts are made', async ({ page }) => {
  await page.goto('/login');
  await waitForSettled(page);

  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: /sign in with uae pass/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /government sso/i })).toBeVisible();
});

/*
 * Whether there is a route to an account is the deployment's decision, and the two states
 * are mutually exclusive: offering registration while still saying access is provisioned
 * by an administrator would contradict itself on one screen. Testing exactly one of them
 * holds against a deployment configured either way, which is what this suite runs against.
 */
test('offers a route to an account, or says who provisions one — never both', async ({ page }) => {
  await page.goto('/login');
  await waitForSettled(page);

  const register = page.getByRole('link', { name: /create one/i });
  const provisioned = page.getByText(/provisioned by your entity administrator/i);

  const offersRegistration = (await register.count()) > 0;
  if (offersRegistration) {
    await expect(register).toBeVisible();
    await expect(provisioned).toHaveCount(0);

    // The link has to reach a page that can actually take a registration.
    await register.click();
    await expect(page).toHaveURL(/\/register/);
    await expect(page.getByLabel(/work email/i)).toBeVisible();
  } else {
    await expect(provisioned).toBeVisible();
  }
});

test('says plainly when a provider is not configured, rather than failing on click', async ({
  page,
}) => {
  await page.goto('/login');
  await waitForSettled(page);

  const uaePass = page.getByRole('button', { name: /sign in with uae pass/i });
  await expect(uaePass).toBeDisabled();
  await expect(page.getByText(/not configured for this deployment/i).first()).toBeVisible();
});

test('turns the page round in Arabic and keeps the choice across a reload', async ({ page }) => {
  await page.goto('/login');
  await waitForSettled(page);

  await page.getByRole('button', { name: 'العربية' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.getByRole('heading', { name: 'تسجيل الدخول إلى مساحة العمل' })).toBeVisible();

  await page.reload();
  await waitForSettled(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
});

test('the accessibility panel changes the page and the change survives a reload', async ({
  page,
}) => {
  await page.goto('/login');
  await waitForSettled(page);

  await page.getByRole('button', { name: /accessibility options/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('radio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await dialog.getByRole('radio', { name: 'Large', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.reload();
  await waitForSettled(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');

  // Put it back, so one run does not decide what the next one sees.
  await page.getByRole('button', { name: /accessibility options/i }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /reset accessibility/i })
    .click();
  await page.keyboard.press('Escape');
});

test('refuses an address outside the approved domains, at the field', async ({ page }) => {
  await page.goto('/login');
  await waitForSettled(page);
  await openCredentials(page);

  // A domain this deployment does not accept. Which domains those are is configuration,
  // so the message says the rule without saying anything about the account.
  await page.getByLabel('Government email').fill('someone@outlook.com');
  await page.getByLabel(/^Password/).fill('a-password');
  await page.getByRole('button', { name: 'Sign in securely' }).click();

  await expect(page.getByText(/government address issued by your entity/i)).toBeVisible();
});

test('can be completed with the keyboard alone', async ({ page }) => {
  await page.goto('/login');
  await waitForSettled(page);
  await openCredentials(page);

  await page.getByLabel('Government email').focus();
  await page.keyboard.type('dr.sadi@uxe.example.com');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Tr0ubad0ur-Nimbus-42');

  // Tab past the reveal button, the checkbox and the recovery link to the submit control.
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  expect(focused).toContain('Sign in securely');

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 30_000 });
});

test('the help panel opens, lists real destinations and returns focus', async ({ page }) => {
  await page.goto('/login');
  await waitForSettled(page);

  const trigger = page.getByRole('button', { name: /help and support/i });
  await trigger.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: /contact support/i })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('every footer link opens a real page', async ({ page }) => {
  for (const [name, path, heading] of [
    [/privacy notice/i, '/legal/privacy', 'Privacy notice'],
    [/^security$/i, '/legal/security', 'Security'],
    [/^accessibility$/i, '/legal/accessibility', 'Accessibility'],
  ] as const) {
    await page.goto('/login');
    await waitForSettled(page);
    await page.getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(path));
    // A real page with real content, not an empty route. Named rather than matched by
    // level, because the sign-in heading is still in the tree mid-transition.
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole('listitem').first()).toBeVisible();
  }
});
