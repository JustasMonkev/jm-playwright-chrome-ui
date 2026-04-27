import type { Browser, Page } from 'playwright-core';

import { browserFrom, sendCDPCommand, withBrowserSession } from './cdp';
import { extensionTargets, tabTargetIdForPage, waitForExtensionPopupURL } from './targets';
import type { ChromeExtension, ChromeUITarget, ExtensionActionOptions, ExtensionSelector } from './types';

const kDefaultTimeout = 5000;

export async function listExtensions(target: ChromeUITarget): Promise<ChromeExtension[]> {
  const browser = browserFrom(target);
  return await withBrowserSession(browser, async session => {
    const result = await sendCDPCommand<{ extensions: ChromeExtension[] }>(session, 'Extensions.getExtensions');
    return result.extensions;
  });
}

export async function triggerExtensionAction(page: Page, options: ExtensionSelector): Promise<ChromeExtension> {
  const browser = browserFrom(page);
  const [extension, targetId] = await Promise.all([
    resolveExtension(browser, options),
    tabTargetIdForPage(page, browser),
  ]);

  await withBrowserSession(browser, async session => {
    await sendCDPCommand(session, 'Extensions.triggerAction', {
      id: extension.id,
      targetId,
    });
  });

  return extension;
}

export async function openExtension(page: Page, options: ExtensionActionOptions): Promise<Page> {
  const browser = browserFrom(page);
  const [extension, targetId] = await Promise.all([
    resolveExtension(browser, options),
    tabTargetIdForPage(page, browser),
  ]);
  const timeout = options.timeout ?? kDefaultTimeout;
  const popupURL = await triggerActionAndFindPopupURL(browser, extension, targetId, timeout);
  return await pageForPopupURL(page, popupURL, timeout);
}

async function triggerActionAndFindPopupURL(browser: Browser, extension: ChromeExtension, targetId: string, timeout: number): Promise<string> {
  return await withBrowserSession(browser, async session => {
    const existingTargetIds = new Set((await extensionTargets(session, extension.id)).map(target => target.targetId));
    await sendCDPCommand(session, 'Extensions.triggerAction', {
      id: extension.id,
      targetId,
    });
    return await waitForExtensionPopupURL(session, extension, existingTargetIds, timeout);
  });
}

async function pageForPopupURL(page: Page, popupURL: string, timeout: number): Promise<Page> {
  const existingPopup = page.context().pages().find(popup => popup.url() === popupURL);
  if (existingPopup)
    return existingPopup;

  const popup = await page.context().newPage();
  await popup.goto(popupURL, { waitUntil: 'domcontentloaded', timeout });
  return popup;
}

async function resolveExtension(browser: Browser, selector: ExtensionSelector): Promise<ChromeExtension> {
  const extensions = await listExtensions(browser);
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
  return !!selector.id || !!selector.name;
}

function matchesName(extensionName: string, selectorName: string | RegExp): boolean {
  if (typeof selectorName === 'string')
    return extensionName === selectorName;
  return selectorName.test(extensionName);
}

function formatExtensions(extensions: ChromeExtension[]): string {
  return extensions.map(extension => `${extension.name} (${extension.id})`).join(', ') || 'none';
}

