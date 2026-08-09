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

## Requirements

- **Chromium with the CDP `Extensions` domain.** `Extensions.getExtensions` and
  `Extensions.triggerAction` are verified present in Chrome 147 and verified
  absent in Chrome 141 — on an older build these helpers fail with a protocol
  error naming the missing command.
- **The full Chrome binary, not the headless shell.** Extensions do load in
  Chrome's new headless mode, so headless runs work as long as you pin
  `channel: 'chromium'`. Playwright's default headless run uses the headless
  shell, which has no extension support.

## Example

```ts
import { chromium } from 'playwright';
import { openExtension } from 'jm-playwright-chrome-ui';

const extensionPath = 'youtube-short-blocker/dist';
const context = await chromium.launchPersistentContext('/tmp/chrome-ui-profile', {
  channel: 'chromium',
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

### Opening extension UI

- `listExtensions(target)` lists loaded Chrome extensions.
- `triggerExtensionAction(page, selector)` triggers an extension toolbar action.
- `openExtension(page, options)` waits for the selected extension, opens its
  action popup, and returns an automatable Playwright `Page`.

### MV3 helpers

- `extensionServiceWorker(target, options)` resolves the extension's MV3
  background service worker as a Playwright `Worker`.
- `getExtensionStorage(target, options)` reads `chrome.storage`.
- `setExtensionStorage(target, values, options)` writes `chrome.storage`.
- `removeExtensionStorage(target, keys, options)` removes keys.
- `clearExtensionStorage(target, options)` clears a storage area.
- `readExtensionManifest(extensionPath)` parses an unpacked `manifest.json`.

The storage helpers take an `area` of `'local'` (default), `'session'`,
`'sync'`, or `'managed'`, and work whether or not any extension page is open —
useful under MV3, where popups are short-lived. Values keep their JSON types in
both directions, so numbers, booleans, arrays and objects need no encoding.

```ts
await setExtensionStorage(context, { blocklist: ['facebook.com'] }, { name: 'My Extension' });
const stored = await getExtensionStorage(context, { name: 'My Extension', keys: ['blocklist'] });
```

## Selecting an extension

Selectors can use `id`, `name`, `path`, or a combination of those fields.
Passing both `name` and `path` is recommended when more than one extension may
be loaded.

`path` may be relative, and may travel through symlinks — it is compared
against Chrome's canonical path, not string-matched.

**`name` is the localized name.** Chrome returns the extension's name resolved
against the browser's UI locale, so an extension whose manifest name is
`__MSG_extName__` reports different names on differently-configured machines.
Prefer `id` or `path` when your extension is localized.

## MV3 notes

**The popup is identified by Chrome's own bubble, not by guessing at targets.**
`openExtension` clicks the action and then looks for the document Chrome
actually opened, falling back to `action.default_popup` from the manifest. Under
MV3 the click also restarts a dormant service worker and can create offscreen
documents, and neither is distinguishable from a popup by URL prefix alone — the
bubble is, because Chrome reports it as the one unattached extension page.

Reading the bubble rather than the manifest also means
`chrome.action.setPopup()` is honoured. The manifest is only the default, and
repointing the action at runtime — including per-tab — is ordinary MV3.

If the extension opens no popup at all — an `action` with only a
`chrome.action.onClicked` handler — `openExtension` says so instead of returning
some other document. Use `triggerExtensionAction` for those extensions.

**The returned page is a tab, not Chrome's popup bubble.** Chrome never emits an
incremental attach event for a popup bubble opened after a client armed
auto-attach, so Playwright never surfaces the bubble as a `Page` on the
connection that launched the browser. `openExtension` therefore triggers the
action, dismisses the bubble, and hosts the popup document in a tab. The popup's
own scripts see a different `chrome.tabs` view as a result:

| | real popup bubble | popup hosted in a tab |
| --- | --- | --- |
| `chrome.tabs.query({active: true, currentWindow: true})` | the page under test | the popup's own tab |
| `chrome.tabs.getCurrent()` | `undefined` | the popup's own tab |

MV3 popups commonly call `chrome.tabs.query` on open, because there is no
persistent background page holding "which tab am I acting on". If yours does,
it will act on the popup's tab under automation.

If that difference matters for your extension, the real bubble *is* reachable:
launch with `--remote-debugging-port`, call `triggerExtensionAction`, wait for a
`chrome-extension://` target of type `page` to carry the popup URL, then
`chromium.connectOverCDP()` — a connection opened while the bubble is already up
enumerates it as a genuine `Page` with full locator support. It needs a fresh
connection per popup, and that connection is yours to close.

**Service workers stop when idle.** `extensionServiceWorker` returns the
currently running worker; that object goes dead when Chrome shuts the worker
down, and calling again returns its replacement.

**MV2 is not supported by recent Chrome.** Chrome 147 refuses to install
manifest v2 extensions outright. The MV2 `browser_action` and `page_action`
popup keys are still read for older browsers.

## Release Checks

```bash
npm run build
npm run typecheck
npm test
npm pack --dry-run
npm publish --dry-run
```
