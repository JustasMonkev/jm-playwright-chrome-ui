import * as path from 'node:path';

import { chromium, expect, test as base, type BrowserContext } from 'playwright/test';

import { listExtensions, openExtension, triggerExtensionAction } from '..';

const popupExtensionPath = path.join(__dirname, 'fixtures', 'popup-extension');
const actionExtensionPath = path.join(__dirname, 'fixtures', 'action-extension');
const extensionPaths = [popupExtensionPath, actionExtensionPath];

const test = base.extend<{ context: BrowserContext }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${extensionPaths.join(',')}`,
        `--load-extension=${extensionPaths.join(',')}`,
      ],
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

test('lists and triggers committed MV3 extensions', async ({ page }) => {
  const extensions = await listExtensions(page);
  const fixturePaths = extensions.map(item => path.resolve(item.path));

  expect(fixturePaths).toEqual(expect.arrayContaining(extensionPaths));
  const triggered = await triggerExtensionAction(page, { path: actionExtensionPath });
  expect(triggered.name).toBe('JM MV3 Fixture');
});

test('opens a popup by relative path without reusing a stale page', async ({ page }) => {
  await page.route('https://target.test/', route => route.fulfill({
    body: '<title>Original target</title>',
    contentType: 'text/html',
  }));
  await page.goto('https://target.test/');
  const relativePath = path.relative(process.cwd(), popupExtensionPath);
  const firstPopup = await openExtension(page, { path: relativePath });
  await expect(firstPopup.getByRole('button', { name: 'Clicks: 0' })).toBeVisible();
  await expect(firstPopup.locator('[data-active-url]')).toHaveText('https://target.test/');
  await expect(firstPopup.locator('[data-worker-status]')).toHaveText('ready');
  await firstPopup.getByRole('button').click();
  await expect(firstPopup.getByRole('button', { name: 'Clicks: 1' })).toBeVisible();

  const secondPopup = await openExtension(page, { path: relativePath });
  expect(secondPopup).not.toBe(firstPopup);
});

test('opens the popup when two tabs have the same URL and title', async ({ context, page }) => {
  const twin = await context.newPage();
  await Promise.all([
    page.setContent('<title>Duplicate target</title>'),
    twin.setContent('<title>Duplicate target</title>'),
  ]);

  const popup = await openExtension(twin, { path: popupExtensionPath });
  await expect(popup.getByRole('heading', { name: 'MV3 popup' })).toBeVisible();
});

test('fails clearly when the extension action has no popup', async ({ page }) => {
  await expect(openExtension(page, { path: actionExtensionPath, timeout: 500 }))
      .rejects.toThrow('did not open a popup');
});
