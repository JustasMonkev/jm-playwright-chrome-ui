# jm-playwright-chrome-ui

Helpers for driving Chrome extension UI from Playwright.

This package is Chromium-only. It uses the experimental Chrome DevTools
Protocol Extensions domain and is tested with Playwright's bundled Chromium.

Use these helpers only in tests with trusted extensions, trusted pages, and
throwaway browser profiles. Do not run them against your day-to-day Chrome
profile or any browser exposed to untrusted remote debugging clients.

## Install

```bash
npm install playwright@1.62 jm-playwright-chrome-ui
npx playwright install chromium
```

## Example

```ts
import * as path from 'node:path';

import { chromium } from 'playwright';
import { openExtension } from 'jm-playwright-chrome-ui';

const extensionPath = path.resolve('my-extension/dist');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

try {
  const page = await context.newPage();
  await page.setContent('<title>Extension target</title>');

  const extensionPage = await openExtension(page, { path: extensionPath });
  await extensionPage.getByRole('button', { name: 'Run' }).click();
} finally {
  await context.close();
}
```

## APi

- `listExtensions(target)` lists loaded Chrome extensions.
- `triggerExtensionAction(page, selector)` triggers an extension toolbar action.
- `openExtension(page, options)` waits for the selected extension, opens its action, and returns an automatable Playwright `Page`.

Selectors can use `id`, `name`, `path`, or a combination of those fields. Passing
both `name` and `path` is recommended when more than one extension may be loaded.

Playwright 1.62 does not expose the native toolbar popup as a `Page`.
`openExtension` therefore returns a fresh, tab-hosted copy of the detected popup
URL. It brings the original page back to the foreground before loading that copy,
so popup code that queries the active tab still sees the page under test. Popup
startup code runs in both the native popup and the tab-hosted copy; keep
irreversible startup effects out of popup initialization.

This release is tested with Playwright 1.62.x and requires Node.js 22 or newer.
CI covers Node.js 22 and 24.

## Release Checks

```bash
npm run build
npm run typecheck
npm run test:unit
npm run test:e2e
npm pack --dry-run
npm publish --dry-run
```
