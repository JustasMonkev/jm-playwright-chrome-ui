# jm-playwright-chrome-ui

Helpers for driving Chrome extension UI from Playwright.

This package is Chromium-only. It uses Chrome DevTools Protocol extension
commands and requires Chromium to be launched with
`--enable-unsafe-extension-debugging`.

Use these helpers only in tests with trusted extensions, trusted pages, and
throwaway browser profiles. Do not run them against your day-to-day Chrome
profile or any browser exposed to untrusted remote debugging clients.

## Install

```bash
npm install playwright jm-playwright-chrome-ui
```

## Example

```ts
import { chromium } from 'playwright';
import { openExtension } from 'jm-playwright-chrome-ui';

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

Selectors can use `id`, `name`, `path`, or a combination of those fields. Passing
both `name` and `path` is recommended when more than one extension may be loaded.

This release is tested with Playwright 1.62.x and requires Node.js 20 or newer.

## Release Checks

```bash
npm run build
npm run typecheck
npm pack --dry-run
npm publish --dry-run
```
