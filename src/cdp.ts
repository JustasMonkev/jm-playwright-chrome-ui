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
  } catch (error: unknown) {
    throw new Error(`Chrome UI helpers require Chromium CDP support: ${errorMessage(error)}`, { cause: error });
  }

  try {
    return await callback(session);
  } finally {
    await session.detach().catch(() => {});
  }
}

type CDPMethod = Parameters<CDPSession['send']>[0];
type DynamicCDPSender = <T>(method: CDPMethod, params?: Record<string, unknown>) => Promise<T>;

export async function sendCDPCommand<T>(session: CDPSession, method: CDPMethod, params?: Record<string, unknown>): Promise<T> {
  try {
    // SAFETY: the method stays in Playwright's CDP union; only its internal parameter mapping is erased.
    const send = session.send.bind(session) as DynamicCDPSender;
    return await send<T>(method, params);
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (method.startsWith('Extensions.') && /wasn't found|not supported|not allowed/i.test(message))
      throw new Error(`Chrome extension UI commands require a recent Chromium build with Extensions CDP support: ${message}`, { cause: error });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertChromiumBrowser(browser: Browser): void {
  const browserType = browser.browserType().name();
  if (browserType !== 'chromium') {
    throw new Error(`Chrome UI helpers only support Chromium browsers. Received "${browserType}".`);
  }
}
