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
} from './types';

const kDefaultTimeout = 5000;
const kPollInterval = 100;
// Triggering the action opens Chrome's own popup bubble. It appears within a few milliseconds;
// this only bounds the case where it never appears (for instance when the click toggled an
// already-open popup shut).
const kPopupDismissTimeout = 1000;

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
 * The popup URL comes from the extension's manifest rather than from whichever
 * chrome-extension:// target appears after the click. Under MV3 that click also restarts a
 * dormant service worker and can create offscreen documents, and those are indistinguishable
 * from a popup by URL prefix alone.
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
    const url = actionPopupURL(extension);
    const targetId = await tabTargetIdForPage(session, page);

    await sendCDPCommand(session, 'Extensions.triggerAction', { id: extension.id, targetId });

    // Leaving Chrome's bubble open would run a second live instance of the popup document
    // alongside the one under test, doubling its storage writes and runtime messages.
    const dismissed = await closeBubbleWithin(session, extension.id, url, Math.min(timeout, kPopupDismissTimeout));
    const popup = await pageForPopupURL(page, url, timeout);
    // The bubble takes a few hundred milliseconds to surface, and longer on a loaded machine.
    // If it had not appeared yet, keep looking now that the hosted tab exists.
    if (!dismissed)
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

function actionPopupURL(extension: ChromeExtension): string {
  const manifest = readExtensionManifest(extension.path);
  if (!manifest.defaultPopup) {
    const key = manifest.manifestVersion >= 3 ? 'action' : 'browser_action';
    throw new Error(`Chrome extension "${extension.name}" does not declare an action popup (${key}.default_popup in its manifest), so clicking its toolbar icon opens no document. Use triggerExtensionAction() to dispatch chrome.action.onClicked instead.`);
  }

  const url = extensionResourceURL(extension.id, manifest.defaultPopup);
  // Chrome installs an extension whose default_popup points at nothing and serves its own error
  // page for it, which would otherwise surface as a puzzling "locator not found" much later.
  const file = popupFilePath(extension.path, url);
  if (file && !fs.existsSync(file))
    throw new Error(`Chrome extension "${extension.name}" declares an action popup at "${manifest.defaultPopup}", but ${file} does not exist.`);

  return url;
}

function popupFilePath(extensionPath: string, popupURL: string): string | undefined {
  try {
    const relative = decodeURIComponent(new URL(popupURL).pathname).replace(/^\/+/, '');
    return relative ? path.join(extensionPath, relative) : undefined;
  } catch {
    // Malformed percent-encoding; leave it to Chrome rather than guessing at a filename.
    return undefined;
  }
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
  if (existingPopup)
    return existingPopup;

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
  return selectorName.test(extensionName);
}

function formatExtensions(extensions: ChromeExtension[]): string {
  return extensions.map(extension => `${extension.name} (${extension.id})`).join(', ') || 'none';
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
