import type { Browser, BrowserContext, CDPSession } from 'playwright-core';

import type { ChromeUITarget } from './types';

export function contextFrom(target: ChromeUITarget): BrowserContext {
  if ('context' in target)
    return target.context();
  if ('pages' in target)
    return target;
  if ('contexts' in target) {
    const [context] = target.contexts();
    if (context)
      return context;
    throw new Error('Chrome UI helpers need an open browser context. Launch one with chromium.launchPersistentContext() so the extension is loaded.');
  }
  throw new Error('Chrome UI helpers require a Playwright Browser, BrowserContext, or Page connected to Chromium.');
}

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
    if (method.startsWith('Extensions.') && /wasn't found|not found|enable-unsafe-extension-debugging|not supported|not allowed/i.test(error.message))
      throw new Error(`"${method}" is unavailable. Chrome extension UI commands require Chromium launched with --enable-unsafe-extension-debugging, and a Chrome build new enough to expose the CDP Extensions domain: ${error.message}`);
    throw error;
  }
}

function assertChromiumBrowser(browser: Browser): void {
  const browserType = browser.browserType().name();
  if (browserType !== 'chromium') {
    throw new Error(`Chrome UI helpers only support Chromium browsers. Received "${browserType}".`);
  }
}
