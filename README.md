# playwright-chrome-ui

Helpers for driving Chrome extension UI from Playwright.

This package is Chromium-only. Launch Chromium with
`--enable-unsafe-extension-debugging` and load an unpacked extension before using
the helpers.

## Install

```bash
npm install
```

## Example

```ts
import { chromium } from 'playwright';
import { openExtension } from 'playwright-chrome-ui';

const extensionPath = 'youtube-short-blocker/dist';
const context = await chromium.launchPersistentContext('/tmp/chrome-ui-profile', {
  headless: false,
  args: [
    '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

const page = await context.newPage();
await page.goto('https://example.com');

const extensionPage = await openExtension(page, {
  name: 'YouTube Shorts Blocker',
  path: extensionPath,
});
await extensionPage.locator('#custom-site').fill('facebook.com');
await extensionPage.getByRole('button', { name: 'Add to blocklist' }).click();

await context.close();
```

## API

- `listExtensions(target)` lists loaded Chrome extensions.
- `triggerExtensionAction(page, selector)` triggers an extension toolbar action.
- `openExtension(page, options)` waits for the selected extension, opens its action, and returns an automatable Playwright `Page`.
