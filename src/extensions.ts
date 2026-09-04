import * as path from 'node:path';

import type { CDPSession, Page } from 'playwright-core';

import { browserFrom, sendCDPCommand, withBrowserSession } from './cdp';
import { extensionTargets, tabTargetIdForPage, waitForExtensionPopupURL } from './targets';
import type { ChromeExtension, ChromeUITarget, ExtensionActionOptions, ExtensionSelector } from './types';

const kDefaultTimeout = 5000;

export async function listExtensions(target: ChromeUITarget): Promise<ChromeExtension[]> {
  const browser = browserFrom(target);
  return await withBrowserSession(browser, listExtensionsForSession);
}

export async function triggerExtensionAction(page: Page, options: ExtensionSelector): Promise<ChromeExtension> {
  const browser = browserFrom(page);
  return await withBrowserSession(browser, async session => {
    const [extension, targetId] = await Promise.all([
      resolveExtension(session, options),
      tabTargetIdForPage(page, session),
    ]);
    await sendCDPCommand(session, 'Extensions.triggerAction', {
      id: extension.id,
      targetId,
    });
    return extension;
  });
}

export async function openExtension(page: Page, options: ExtensionActionOptions): Promise<Page> {
  const browser = browserFrom(page);
  const timeout = options.timeout ?? kDefaultTimeout;
  const popupURL = await withBrowserSession(browser, async session => {
    const [extension, targetId] = await Promise.all([
      waitForExtension(session, options, timeout),
      tabTargetIdForPage(page, session),
    ]);
    return await triggerActionAndFindPopupURL(session, extension, targetId, timeout);
  });
  return await pageForPopupURL(page, popupURL, timeout);
}

async function triggerActionAndFindPopupURL(session: CDPSession, extension: ChromeExtension, targetId: string, timeout: number): Promise<string> {
  const existingTargetIds = new Set((await extensionTargets(session, extension.id)).map(target => target.targetId));
  await sendCDPCommand(session, 'Extensions.triggerAction', {
    id: extension.id,
    targetId,
  });
  return await waitForExtensionPopupURL(session, extension, existingTargetIds, timeout);
}

async function pageForPopupURL(page: Page, popupURL: string, timeout: number): Promise<Page> {
  const popup = await page.context().newPage();
  try {
    // newPage activates the helper tab; restore the action target before popup code runs.
    await page.bringToFront();
    await popup.goto(popupURL, { waitUntil: 'domcontentloaded', timeout });
    return popup;
  } catch (error) {
    await Promise.allSettled([popup.close()]);
    throw error;
  }
}

async function listExtensionsForSession(session: CDPSession): Promise<ChromeExtension[]> {
  const result = await sendCDPCommand<{ extensions: ChromeExtension[] }>(session, 'Extensions.getExtensions');
  return result.extensions;
}

async function resolveExtension(session: CDPSession, selector: ExtensionSelector): Promise<ChromeExtension> {
  const extensions = await listExtensionsForSession(session);
  return extensionMatching(extensions, selector);
}

async function waitForExtension(session: CDPSession, selector: ExtensionSelector, timeout: number): Promise<ChromeExtension> {
  const deadline = Date.now() + timeout;
  let extensions: ChromeExtension[] = [];
  while (Date.now() < deadline) {
    extensions = await listExtensionsForSession(session);
    const matches = extensions.filter(extension => matchesSelector(extension, selector));
    if (matches.length === 1)
      return matches[0];
    if (matches.length > 1)
      throw new Error(`Chrome extension selector matched multiple extensions: ${formatExtensions(matches)}`);
    await delay(100);
  }
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
  if (selector.path && (!extension.path || path.resolve(extension.path) !== path.resolve(selector.path)))
    return false;
  return !!selector.id || !!selector.name || !!selector.path;
}

function matchesName(extensionName: string, selectorName: string | RegExp): boolean {
  if (typeof selectorName === 'string')
    return extensionName === selectorName;
  return new RegExp(selectorName.source, selectorName.flags).test(extensionName);
}

function formatExtensions(extensions: ChromeExtension[]): string {
  return extensions.map(extension => `${extension.name} (${extension.id})`).join(', ') || 'none';
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
