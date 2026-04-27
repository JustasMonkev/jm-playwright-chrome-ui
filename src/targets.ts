import type { Browser, CDPSession, Page } from 'playwright-core';

import { sendCDPCommand, withBrowserSession } from './cdp';
import type { ChromeExtension, TargetInfo } from './types';

export async function tabTargetIdForPage(page: Page, browser: Browser): Promise<string> {
  await page.bringToFront();
  const pageTargetInfo = await pageTargetInfoFor(page);
  return await matchingTabTargetId(browser, page, pageTargetInfo);
}

export async function waitForExtensionPopupURL(session: CDPSession, extension: ChromeExtension, existingTargetIds: Set<string>, timeout: number): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const popupURL = await newExtensionTargetURL(session, extension.id, existingTargetIds);
    if (popupURL)
      return popupURL;
    await delay(100);
  }
  throw new Error(`Extension "${extension.name}" did not open a popup within ${timeout}ms. Make sure the extension has a default action popup.`);
}

export async function extensionTargets(session: CDPSession, extensionId: string): Promise<TargetInfo[]> {
  const { targetInfos } = await sendCDPCommand<{ targetInfos: TargetInfo[] }>(session, 'Target.getTargets', {
    filter: [{}],
  });
  return targetInfos.filter(target => target.url.startsWith(`chrome-extension://${extensionId}/`));
}

async function pageTargetInfoFor(page: Page): Promise<TargetInfo> {
  const session = await page.context().newCDPSession(page);
  try {
    const result = await sendCDPCommand<{ targetInfo: TargetInfo }>(session, 'Target.getTargetInfo');
    return result.targetInfo;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function matchingTabTargetId(browser: Browser, page: Page, pageTargetInfo: TargetInfo): Promise<string> {
  return await withBrowserSession(browser, async session => {
    const candidates = await tabTargets(session);
    const matches = candidates.filter(target => matchesPageTarget(target, pageTargetInfo));
    if (matches.length === 1)
      return matches[0].targetId;
    if (!matches.length)
      throw new Error(`Could not find a Chrome tab target for page "${page.url()}".`);
    throw new Error(`Could not uniquely identify the Chrome tab target for page "${page.url()}". Make sure the page URL and title are unique among open tabs.`);
  });
}

async function tabTargets(session: CDPSession): Promise<TargetInfo[]> {
  const { targetInfos } = await sendCDPCommand<{ targetInfos: TargetInfo[] }>(session, 'Target.getTargets', {
    filter: [{ type: 'tab' }],
  });
  return targetInfos;
}

function matchesPageTarget(tabTarget: TargetInfo, pageTarget: TargetInfo): boolean {
  return tabTarget.browserContextId === pageTarget.browserContextId &&
    tabTarget.url === pageTarget.url &&
    tabTarget.title === pageTarget.title;
}

async function newExtensionTargetURL(session: CDPSession, extensionId: string, existingTargetIds: Set<string>): Promise<string | undefined> {
  for (const target of await extensionTargets(session, extensionId)) {
    if (!existingTargetIds.has(target.targetId))
      return target.url;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

