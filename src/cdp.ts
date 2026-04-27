import type { Browser, CDPSession } from 'playwright-core';

import type { ChromeUITarget } from './types';

export function browserFrom(target: ChromeUITarget): Browser {
  if ('newBrowserCDPSession' in target)
    return target;
  if ('browser' in target) {
    const browser = target.browser();
    if (browser)
      return browser;
  }
  if ('context' in target) {
    const browser = target.context().browser();
    if (browser)
      return browser;
  }
  throw new Error('Chrome UI helpers require a Playwright Browser, BrowserContext, or Page connected to Chromium.');
}

export async function withBrowserSession<T>(browser: Browser, callback: (session: CDPSession) => Promise<T>): Promise<T> {
  assertChromiumBrowser(browser);

  let session: CDPSession;
  try {
    session = await browser.newBrowserCDPSession();
  } catch (error: any) {
    throw new Error(`Chrome UI helpers require Chromium CDP support: ${error.message}`);
  }

  try {
    return await callback(session);
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function sendCDPCommand<T>(session: CDPSession, method: string, params?: object): Promise<T> {
  try {
    return await (session as any).send(method, params);
  } catch (error: any) {
    if (method.startsWith('Extensions.') && /wasn't found|enable-unsafe-extension-debugging|not supported|not allowed/i.test(error.message))
      throw new Error(`Chrome extension UI commands require Chromium launched with --enable-unsafe-extension-debugging: ${error.message}`);
    throw error;
  }
}

function assertChromiumBrowser(browser: Browser): void {
  const browserType = browser.browserType().name();
  if (browserType !== 'chromium') {
    throw new Error(`Chrome UI helpers only support Chromium browsers. Received "${browserType}".`);
  }
}

