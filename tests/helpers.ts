import * as path from 'node:path';

import { chromium } from 'playwright/test';
import type { BrowserContext } from 'playwright-core';

export function fixturePath(name: string): string {
  return path.join(__dirname, 'fixtures', name);
}

/**
 * Extensions only load in Chrome's full browser binary. Playwright's default headless run uses
 * the headless shell, which has no extension support, so pin `channel: 'chromium'` — its new
 * headless mode does load extensions.
 */
export async function launchWithExtension(extensionPath: string, userDataDir: string): Promise<BrowserContext> {
  return await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

/** Every target Chrome reports for a URL, including the duplicate `tab` entry per document. */
export async function targetsForURL(context: BrowserContext, url: string): Promise<{ type?: string; url: string }[]> {
  const session = await context.browser()!.newBrowserCDPSession();
  try {
    const { targetInfos } = await (session as any).send('Target.getTargets', { filter: [{}] });
    return targetInfos.filter((target: any) => target.url === url);
  } finally {
    await session.detach().catch(() => {});
  }
}
