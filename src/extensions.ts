import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BrowserContext, CDPSession, Page, Worker } from 'playwright-core';

import { browserFrom, contextFrom, sendCDPCommand, withBrowserSession } from './cdp';
import { extensionResourceURL, readExtensionManifest } from './manifest';
import { samePath } from './paths';
import { clearStorage, readStorage, removeStorage, withExtensionPageSession, writeStorage } from './storage';
import { extensionDocumentTargets, tabTargetIdForPage } from './targets';
import type {
  ChromeExtension,
  ChromeUITarget,
  ExtensionActionOptions,
  ExtensionSelector,
  ExtensionStorageOptions,
  ExtensionStorageReadOptions,
  TargetInfo,
} from './types';

const kDefaultTimeout = 5000;
const kPollInterval = 100;
// Triggering the action opens Chrome's own popup bubble. It appears within a few milliseconds;
// this only bounds the case where it never appears (for instance when the click toggled an
// already-open popup shut).
const kPopupDismissTimeout = 1000;
// How long to wait for Chrome's bubble to surface. It appears a few hundred milliseconds after
// the click; only an extension whose action opens nothing waits this out in full.
const kBubbleTimeout = 2000;

export async function listExtensions(target: ChromeUITarget): Promise<ChromeExtension[]> {
  const browser = browserFrom(target);
  return await withBrowserSession(browser, session => extensionsOnSession(session));
}

export async function triggerExtensionAction(page: Page, options: ExtensionSelector): Promise<ChromeExtension> {
  const browser = browserFrom(page);
  return await withBrowserSession(browser, async session => {
    const extension = extensionMatching(await extensionsOnSession(session), options);
    const targetId = await tabTargetIdForPage(session, page);
    await sendCDPCommand(session, 'Extensions.triggerAction', { id: extension.id, targetId });
    return extension;
  });
}

/**
 * Clicks the extension's toolbar action for `page`, then returns the popup document as an
 * automatable Page.
 *
 * The popup is identified by Chrome's own bubble, falling back to the manifest, rather than by
 * whichever chrome-extension:// target turns up after the click. Under MV3 that click also
 * restarts a dormant service worker and can create offscreen documents, and those are
 * indistinguishable from a popup by URL prefix alone.
 *
 * Chrome never surfaces its own popup bubble as a Page on the connection that launched the
 * browser, so the popup document is hosted in a tab instead. See the README for the
 * `chrome.tabs` differences that implies, and for how to reach the real bubble if they matter.
 */
export async function openExtension(page: Page, options: ExtensionActionOptions): Promise<Page> {
  const browser = browserFrom(page);
  const timeout = options.timeout ?? kDefaultTimeout;

  // Two concurrent calls would each see no popup tab yet and each open one, leaving two live
  // instances of the popup document.
  return await withPopupLock(page.context(), () => withBrowserSession(browser, async session => {
    const extension = await waitForExtension(session, options, timeout);
    const declared = declaredPopupURL(extension);
    const targetId = await tabTargetIdForPage(session, page);

    await sendCDPCommand(session, 'Extensions.triggerAction', { id: extension.id, targetId });

    // Chrome's own bubble is the authority on which document the action opens. The manifest is
    // only the default: chrome.action.setPopup() routinely repoints the action at runtime, and
    // per-tab popups are an ordinary MV3 pattern.
    const bubble = await waitForActionPopupBubble(session, extension.id, Math.min(timeout, kBubbleTimeout));
    const url = bubble?.url ?? declared;
    if (!url)
      throw noActionPopupError(extension);
    assertPopupFileExists(extension, url);

    // Leaving the bubble open would run a second live instance of the popup document alongside
    // the one under test, doubling its storage writes and runtime messages.
    if (bubble)
      await sendCDPCommand(session, 'Target.closeTarget', { targetId: bubble.targetId }).catch(() => {});

    const popup = await pageForPopupURL(page, url, timeout);
    // The bubble surfaces a few hundred milliseconds after the click, and later on a loaded
    // machine. If it had not appeared yet, look again now that the hosted tab exists.
    if (!bubble)
      await closeBubbleWithin(session, extension.id, url, Math.min(timeout, kPopupDismissTimeout));
    return popup;
  }));
}

/**
 * Resolves the extension's MV3 background service worker.
 *
 * MV3 workers stop when idle and restart on demand, so the returned Worker refers to the
 * currently running instance and goes dead when Chrome shuts it down. Call again to get the
 * replacement.
 */
export async function extensionServiceWorker(target: ChromeUITarget, options: ExtensionActionOptions): Promise<Worker> {
  const browser = browserFrom(target);
  const context = contextFrom(target);
  const timeout = options.timeout ?? kDefaultTimeout;

  const extension = await withBrowserSession(browser, session => waitForExtension(session, options, timeout));
  const origin = `chrome-extension://${extension.id}/`;

  const deadline = Date.now() + timeout;
  do {
    const worker = context.serviceWorkers().find(candidate => candidate.url().startsWith(origin));
    if (worker)
      return worker;
    await delay(kPollInterval);
  } while (Date.now() < deadline);

  throw new Error(`Chrome extension "${extension.name}" has no running service worker after ${timeout}ms. MV2 extensions use a background page rather than a service worker, and an MV3 worker that has gone idle only restarts when the extension next receives an event.`);
}

export async function getExtensionStorage(target: ChromeUITarget, options: ExtensionStorageReadOptions): Promise<Record<string, unknown>> {
  return await withExtensionStorageSession(target, options, (session, id) =>
    readStorage(session, id, options.area ?? 'local', options.keys));
}

export async function setExtensionStorage(target: ChromeUITarget, values: Record<string, unknown>, options: ExtensionStorageOptions): Promise<void> {
  await withExtensionStorageSession(target, options, (session, id) =>
    writeStorage(session, id, options.area ?? 'local', values));
}

export async function removeExtensionStorage(target: ChromeUITarget, keys: string[], options: ExtensionStorageOptions): Promise<void> {
  await withExtensionStorageSession(target, options, (session, id) =>
    removeStorage(session, id, options.area ?? 'local', keys));
}

export async function clearExtensionStorage(target: ChromeUITarget, options: ExtensionStorageOptions): Promise<void> {
  await withExtensionStorageSession(target, options, (session, id) =>
    clearStorage(session, id, options.area ?? 'local'));
}

async function withExtensionStorageSession<T>(
  target: ChromeUITarget,
  options: ExtensionStorageOptions,
  callback: (session: CDPSession, extensionId: string) => Promise<T>,
): Promise<T> {
  const browser = browserFrom(target);
  const context = contextFrom(target);
  const timeout = options.timeout ?? kDefaultTimeout;
  const extension = await withBrowserSession(browser, session => waitForExtension(session, options, timeout));
  return await withExtensionPageSession(context, extension.id, session => callback(session, extension.id));
}

function declaredPopupURL(extension: ChromeExtension): string | undefined {
  const manifest = readExtensionManifest(extension.path);
  return manifest.defaultPopup ? extensionResourceURL(extension.id, manifest.defaultPopup) : undefined;
}

function noActionPopupError(extension: ChromeExtension): Error {
  return new Error(`Chrome extension "${extension.name}" opened no action popup: its manifest declares no default_popup and nothing set one with chrome.action.setPopup(), so clicking the toolbar icon dispatches chrome.action.onClicked instead. Use triggerExtensionAction() for that.`);
}

// Chrome installs an extension whose popup points at nothing and serves its own error page for
// it, which would otherwise surface as a puzzling "locator not found" much later.
function assertPopupFileExists(extension: ChromeExtension, popupURL: string): void {
  const file = popupFilePath(extension.path, popupURL);
  if (file && !fs.existsSync(file))
    throw new Error(`Chrome extension "${extension.name}" points its action at "${popupURL}", but ${file} does not exist.`);
}

function popupFilePath(extensionPath: string, popupURL: string): string | undefined {
  let relative: string;
  try {
    relative = decodeURIComponent(new URL(popupURL).pathname).replace(/^\/+/, '');
  } catch {
    // Malformed percent-encoding; leave it to Chrome rather than guessing at a filename.
    return undefined;
  }
  if (!relative)
    return undefined;

  // Percent-encoded traversal survives URL normalisation and would otherwise let the existence
  // check reach outside the extension directory.
  const file = path.resolve(extensionPath, relative);
  const root = path.resolve(extensionPath);
  return file === root || file.startsWith(root + path.sep) ? file : undefined;
}

async function waitForActionPopupBubble(session: CDPSession, extensionId: string, budget: number): Promise<TargetInfo | undefined> {
  const deadline = Date.now() + budget;
  do {
    const bubble = (await extensionDocumentTargets(session, extensionId))
      .find(target => target.attached === false);
    if (bubble)
      return bubble;
    await delay(25);
  } while (Date.now() < deadline);
  return undefined;
}

async function closeBubbleWithin(session: CDPSession, extensionId: string, popupURL: string, budget: number): Promise<boolean> {
  const deadline = Date.now() + budget;
  do {
    // Only unattached targets: every page Playwright owns — the popup tab, a tab the test
    // opened, a tab the extension opened with chrome.tabs.create — reports attached, and
    // closing one of those would destroy a page the caller is using.
    const bubble = (await extensionDocumentTargets(session, extensionId))
      .find(target => target.attached === false && isSameDocument(target.url, popupURL));
    if (bubble) {
      await sendCDPCommand(session, 'Target.closeTarget', { targetId: bubble.targetId }).catch(() => {});
      return true;
    }
    await delay(25);
  } while (Date.now() < deadline);
  // The bubble closes itself when focus moves, so not finding one is normal.
  return false;
}

async function pageForPopupURL(page: Page, popupURL: string, timeout: number): Promise<Page> {
  const existingPopup = page.context().pages()
    .find(popup => !popup.isClosed() && isSameDocument(popup.url(), popupURL));
  if (existingPopup) {
    // It may still be navigating — a page parked on the popup URL is not necessarily ready.
    await existingPopup.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    return existingPopup;
  }

  const popup = await page.context().newPage();
  await popup.goto(popupURL, { waitUntil: 'domcontentloaded', timeout });
  return popup;
}

// Extension popups routinely rewrite their own URL on load — `location.replace(path + '#/home')`
// is the standard hash-router opening move — so the live document rarely matches the manifest
// URL exactly. Compare everything but the fragment.
function isSameDocument(url: string, popupURL: string): boolean {
  return withoutFragment(url) === withoutFragment(popupURL);
}

function withoutFragment(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

// Serialises popup opening per browser context so concurrent callers share one popup tab.
const popupLocks = new WeakMap<BrowserContext, Promise<unknown>>();

function withPopupLock<T>(context: BrowserContext, operation: () => Promise<T>): Promise<T> {
  const previous = popupLocks.get(context) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  popupLocks.set(context, result.catch(() => {}));
  return result;
}

async function extensionsOnSession(session: CDPSession): Promise<ChromeExtension[]> {
  const { extensions } = await sendCDPCommand<{ extensions: ChromeExtension[] }>(session, 'Extensions.getExtensions');
  return extensions.map(withManifestVersion);
}

// Best effort: an extension directory the test process cannot read still yields a usable record.
function withManifestVersion(extension: ChromeExtension): ChromeExtension {
  try {
    return { ...extension, manifestVersion: readExtensionManifest(extension.path).manifestVersion };
  } catch {
    return { ...extension };
  }
}

async function waitForExtension(session: CDPSession, selector: ExtensionSelector, timeout: number): Promise<ChromeExtension> {
  const deadline = Date.now() + timeout;
  let extensions: ChromeExtension[] = [];
  do {
    extensions = await extensionsOnSession(session);
    const matches = extensions.filter(extension => matchesSelector(extension, selector));
    if (matches.length === 1)
      return matches[0];
    if (matches.length > 1)
      throw new Error(`Chrome extension selector matched multiple extensions: ${formatExtensions(matches)}`);
    await delay(kPollInterval);
  } while (Date.now() < deadline);
  throw new Error(`No Chrome extension matches the selector within ${timeout}ms. Available extensions: ${formatExtensions(extensions)}`);
}

function extensionMatching(extensions: ChromeExtension[], selector: ExtensionSelector): ChromeExtension {
  const matches = extensions.filter(extension => matchesSelector(extension, selector));
  if (!matches.length)
    throw new Error(`No Chrome extension matches the selector. Available extensions: ${formatExtensions(extensions)}`);
  if (matches.length > 1)
    throw new Error(`Chrome extension selector matched multiple extensions: ${formatExtensions(matches)}`);
  return matches[0];
}

function matchesSelector(extension: ChromeExtension, selector: ExtensionSelector): boolean {
  if (selector.id && extension.id !== selector.id)
    return false;
  if (selector.name && !matchesName(extension.name, selector.name))
    return false;
  // Chrome reports an absolute, symlink-resolved path; callers pass whatever they gave
  // --load-extension, which is commonly relative.
  if (selector.path && !samePath(extension.path, selector.path))
    return false;
  return !!selector.id || !!selector.name || !!selector.path;
}

function matchesName(extensionName: string, selectorName: string | RegExp): boolean {
  if (typeof selectorName === 'string')
    return extensionName === selectorName;
  // A /g or /y regexp carries lastIndex between calls, so testing several extensions with the
  // same selector would skip matches and quietly turn "matched multiple" into "matched one".
  const stateless = new RegExp(selectorName.source, selectorName.flags.replace(/[gy]/g, ''));
  return stateless.test(extensionName);
}

function formatExtensions(extensions: ChromeExtension[]): string {
  return extensions.map(extension => `${extension.name} (${extension.id})`).join(', ') || 'none';
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
