import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test as setup } from '@playwright/test';
import { SEED_EMAIL, SEED_PASSWORD, STORAGE_STATE, openCredentials } from './fixtures.js';

/**
 * Signs in once for the whole run.
 *
 * Sign-in is rate limited per IP — deliberately, and the security suite asserts it. A
 * suite that re-authenticated for every test at every viewport would trip that limit and
 * report the product broken when it is behaving exactly as designed. The specs that are
 * *about* signing in start from a clean context instead.
 */
setup('authenticate', async ({ page }) => {
  await mkdir(dirname(STORAGE_STATE), { recursive: true });

  await page.goto('/login');
  await openCredentials(page);
  await page.getByLabel('Government email').fill(SEED_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in securely' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

  await page.context().storageState({ path: STORAGE_STATE });
});
