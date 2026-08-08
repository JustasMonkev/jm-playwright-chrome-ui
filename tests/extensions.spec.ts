import * as path from 'node:path';

import { expect, test } from 'playwright/test';

import {
  clearExtensionStorage,
  extensionServiceWorker,
  getExtensionStorage,
  listExtensions,
  openExtension,
  removeExtensionStorage,
  setExtensionStorage,
  triggerExtensionAction,
} from '..';
import { fixturePath, launchWithExtension, targetsForURL } from './helpers';

const offscreenFixture = fixturePath('mv3-offscreen');

test('opens the action popup rather than an offscreen document', async ({}, testInfo) => {
  // The service worker creates an offscreen document, so the extension origin serves several
  // targets. Matching on the chrome-extension:// URL prefix alone picks the wrong one.
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');

  const popup = await openExtension(page, { name: 'MV3 Offscreen Fixture', timeout: 10_000 });

  expect(popup.url()).toMatch(/\/popup\.html$/);
  await expect(popup.locator('#surface')).toHaveText('popup');
  await context.close();
});

test('resolves a popup nested in a subdirectory', async ({}, testInfo) => {
  const context = await launchWithExtension(fixturePath('mv3-nested-popup'), testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');

  const popup = await openExtension(page, { name: 'MV3 Nested Popup Fixture', timeout: 10_000 });

  expect(popup.url()).toMatch(/\/ui\/popup\.html$/);
  await expect(popup.locator('#surface')).toHaveText('nested popup');
  await context.close();
});

test('fails fast when the extension declares no action popup', async ({}, testInfo) => {
  // Clicking this extension's action dispatches chrome.action.onClicked, which creates an
  // offscreen document. Waiting for a new extension target would return that document.
  const context = await launchWithExtension(fixturePath('mv3-no-popup'), testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');

  await expect(openExtension(page, { name: 'MV3 No Popup Fixture', timeout: 10_000 }))
    .rejects.toThrow(/does not declare an action popup/);
  await context.close();
});

test('reports a declared popup whose file is missing', async ({}, testInfo) => {
  // Chrome installs this happily and serves its own error page for the popup, which would
  // otherwise surface as a puzzling missing locator.
  const context = await launchWithExtension(fixturePath('mv3-missing-popup'), testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');

  await expect(openExtension(page, { name: 'MV3 Missing Popup Fixture', timeout: 10_000 }))
    .rejects.toThrow(/declares an action popup at "popup\.html", but .*popup\.html does not exist/);
  await context.close();
});

test('matches an extension by a relative path', async ({}, testInfo) => {
  // Chrome reports an absolute, symlink-resolved path; callers pass what they gave
  // --load-extension.
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');

  const relative = path.relative(process.cwd(), offscreenFixture);
  const popup = await openExtension(page, { name: 'MV3 Offscreen Fixture', path: relative, timeout: 10_000 });

  expect(popup.url()).toMatch(/\/popup\.html$/);
  await context.close();
});

test('finds the right tab when several tabs share a URL and title', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const identical = 'data:text/html,<title>Same</title><h1>same</h1>';
  const first = await context.newPage();
  await first.goto(identical);
  const second = await context.newPage();
  await second.goto(identical);

  const popup = await openExtension(second, { name: 'MV3 Offscreen Fixture', timeout: 10_000 });

  expect(popup.url()).toMatch(/\/popup\.html$/);
  await context.close();
});

test('leaves only one live instance of the popup document', async ({}, testInfo) => {
  // Triggering the action opens Chrome's own popup bubble. Left open, it runs a second copy of
  // the popup alongside the one under test.
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');

  const popup = await openExtension(page, { name: 'MV3 Offscreen Fixture', timeout: 10_000 });
  const documents = (await targetsForURL(context, popup.url())).filter(target => target.type === 'page');

  expect(documents).toHaveLength(1);
  await context.close();
});

test('reuses an already-open popup page', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');

  const first = await openExtension(page, { name: 'MV3 Offscreen Fixture', timeout: 10_000 });
  const second = await openExtension(page, { name: 'MV3 Offscreen Fixture', timeout: 10_000 });

  expect(second).toBe(first);
  await context.close();
});

test('reuses the popup tab when the popup rewrites its own URL', async ({}, testInfo) => {
  // Hash routing means the live document URL stops matching the manifest URL. Comparing them
  // exactly would open a fresh tab, and leak a live popup instance, on every call.
  const context = await launchWithExtension(fixturePath('mv3-hash-popup'), testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');
  const selector = { name: 'MV3 Hash Router Fixture', timeout: 10_000 };

  const first = await openExtension(page, selector);
  await expect.poll(() => first.url()).toMatch(/popup\.html#\/home$/);
  const second = await openExtension(page, selector);
  const third = await openExtension(page, selector);

  expect(second).toBe(first);
  expect(third).toBe(first);
  const documents = (await targetsForURL(context, first.url())).filter(target => target.type === 'page');
  expect(documents).toHaveLength(1);
  await context.close();
});

test('does not close a tab that reaches the popup URL while it is working', async ({}, testInfo) => {
  // Chrome's bubble and a test-owned tab sit on the same URL. Only the bubble is unattached, so
  // that is the only thing safe to close — a tab arriving mid-flight must survive.
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');
  const [extension] = await listExtensions(context);
  const mine = await context.newPage();

  await Promise.all([
    openExtension(page, { name: 'MV3 Offscreen Fixture', timeout: 10_000 }),
    (async () => {
      await new Promise(resolve => setTimeout(resolve, 140));
      await mine.goto(`chrome-extension://${extension.id}/popup.html`);
    })(),
  ]);

  expect(mine.isClosed()).toBe(false);
  await expect(mine.locator('#surface')).toHaveText('popup');
  await context.close();
});

test('concurrent calls share one popup tab', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const first = await context.newPage();
  await first.goto('data:text/html,<title>First</title><h1>a</h1>');
  const second = await context.newPage();
  await second.goto('data:text/html,<title>Second</title><h1>b</h1>');
  const selector = { name: 'MV3 Offscreen Fixture', timeout: 10_000 };

  const [a, b] = await Promise.all([openExtension(first, selector), openExtension(second, selector)]);

  expect(a).toBe(b);
  const documents = (await targetsForURL(context, a.url())).filter(target => target.type === 'page');
  expect(documents).toHaveLength(1);
  await context.close();
});

test('concurrent storage calls do not close each other\'s scratch page', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const selector = { name: 'MV3 Offscreen Fixture' };

  // Overlapping helpers each need a page on the extension origin; one must not adopt and then
  // lose the page another opened. A stagger lands the second call inside the first's window.
  for (const stagger of [0, 30, 45, 60, 75]) {
    const reading = getExtensionStorage(context, selector);
    await new Promise(resolve => setTimeout(resolve, stagger));
    const writing = setExtensionStorage(context, { [`key${stagger}`]: stagger }, selector);
    await Promise.all([reading, writing]);
  }

  expect(await getExtensionStorage(context, selector))
    .toEqual({ key0: 0, key30: 30, key45: 45, key60: 60, key75: 75 });
  await context.close();
});

test('reports the manifest version alongside the extension', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));

  const extensions = await listExtensions(context);

  expect(extensions).toHaveLength(1);
  expect(extensions[0]).toMatchObject({ name: 'MV3 Offscreen Fixture', manifestVersion: 3, enabled: true });
  await context.close();
});

test('dispatches chrome.action.onClicked for an extension with no popup', async ({}, testInfo) => {
  const context = await launchWithExtension(fixturePath('mv3-no-popup'), testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');

  const extension = await triggerExtensionAction(page, { name: 'MV3 No Popup Fixture' });

  expect(extension.name).toBe('MV3 No Popup Fixture');
  await expect.poll(
    () => getExtensionStorage(context, { name: 'MV3 No Popup Fixture' }),
    { timeout: 10_000 },
  ).toMatchObject({ clicked: true });
  await context.close();
});

test('rejects a selector that matches no extension instead of triggering an unknown id', async ({}, testInfo) => {
  // Extensions.triggerAction crashes the browser process when handed an id Chrome does not
  // know, so the id must always come from Extensions.getExtensions.
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');

  await expect(triggerExtensionAction(page, { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))
    .rejects.toThrow(/No Chrome extension matches the selector/);
  expect(context.browser()!.isConnected()).toBe(true);
  await context.close();
});

test('reads and writes extension storage without an extension page open', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const selector = { name: 'MV3 Offscreen Fixture' };

  await setExtensionStorage(context, { note: 'hello', count: 3, nested: { a: [1, 2] }, flag: false }, selector);

  // Values keep their JSON types in both directions.
  expect(await getExtensionStorage(context, selector))
    .toEqual({ note: 'hello', count: 3, nested: { a: [1, 2] }, flag: false });
  expect(await getExtensionStorage(context, { ...selector, keys: ['note'] })).toEqual({ note: 'hello' });

  await removeExtensionStorage(context, ['note'], selector);
  expect(await getExtensionStorage(context, selector)).not.toHaveProperty('note');

  await clearExtensionStorage(context, selector);
  expect(await getExtensionStorage(context, selector)).toEqual({});
  await context.close();
});

test('reaches the MV3-only session storage area', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const selector = { name: 'MV3 Offscreen Fixture', area: 'session' as const };

  await setExtensionStorage(context, { ephemeral: true }, selector);

  expect(await getExtensionStorage(context, selector)).toEqual({ ephemeral: true });
  expect(await getExtensionStorage(context, { name: 'MV3 Offscreen Fixture' })).toEqual({});
  await context.close();
});

test('storage written through CDP is visible to the extension itself', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');
  await setExtensionStorage(context, { seeded: { by: 'cdp' } }, { name: 'MV3 Offscreen Fixture' });

  const popup = await openExtension(page, { name: 'MV3 Offscreen Fixture', timeout: 10_000 });

  expect(await popup.evaluate(() => (globalThis as any).chrome.storage.local.get('seeded')))
    .toEqual({ seeded: { by: 'cdp' } });
  await context.close();
});

test('what the popup writes is readable through CDP', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));
  const page = await context.newPage();
  await page.goto('data:text/html,<title>Under test</title><h1>host</h1>');
  const popup = await openExtension(page, { name: 'MV3 Offscreen Fixture', timeout: 10_000 });

  await popup.locator('#note').fill('from the popup');
  await popup.getByRole('button', { name: 'Save note' }).click();
  await expect(popup.locator('#surface')).toHaveText('saved');

  expect(await getExtensionStorage(context, { name: 'MV3 Offscreen Fixture', keys: ['note'] }))
    .toEqual({ note: 'from the popup' });
  await context.close();
});

test('resolves the MV3 background service worker', async ({}, testInfo) => {
  const context = await launchWithExtension(offscreenFixture, testInfo.outputPath('profile'));

  const worker = await extensionServiceWorker(context, { name: 'MV3 Offscreen Fixture', timeout: 10_000 });

  expect(worker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/sw\.js$/);
  expect(await worker.evaluate(() => typeof (globalThis as any).chrome.runtime.onInstalled)).toBe('object');
  await context.close();
});
