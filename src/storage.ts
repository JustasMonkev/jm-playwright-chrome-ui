import type { BrowserContext, CDPSession } from 'playwright-core';

import { sendCDPCommand } from './cdp';

/**
 * The Extensions storage commands resolve the extension relative to the session's own origin:
 * sent on a browser session they fail with "No associated browser context", and on an ordinary
 * web page with "Extension not found". They must travel on a session attached to a page served
 * from the extension itself.
 *
 * Reuses an already-open extension page when there is one, so tests that have a popup open do
 * not see a tab flicker.
 */
export async function withExtensionPageSession<T>(
  context: BrowserContext,
  extensionId: string,
  callback: (session: CDPSession) => Promise<T>,
): Promise<T> {
  const origin = `chrome-extension://${extensionId}/`;
  // manifest.json is the one resource every unpacked extension is guaranteed to serve, so it is
  // what a scratch page navigates to. Never adopt a page sitting on it: it belongs to another
  // call in flight, which will close it again as soon as that call finishes.
  const scratchURL = `${origin}manifest.json`;
  const existing = context.pages().find(page =>
    !page.isClosed() && page.url().startsWith(origin) && page.url() !== scratchURL);
  const page = existing ?? await context.newPage();

  try {
    if (!existing)
      await page.goto(scratchURL);
    const session = await context.newCDPSession(page);
    try {
      return await callback(session);
    } finally {
      await session.detach().catch(() => {});
    }
  } finally {
    if (!existing)
      await page.close().catch(() => {});
  }
}

// Despite the protocol declaring these as string maps, Chrome round-trips real JSON: numbers,
// booleans, arrays and objects survive in both directions without manual encoding.
export async function readStorage(session: CDPSession, id: string, storageArea: string, keys?: string[]): Promise<Record<string, unknown>> {
  const { data } = await sendCDPCommand<{ data: Record<string, unknown> }>(session, 'Extensions.getStorageItems', {
    id,
    storageArea,
    ...(keys ? { keys } : {}),
  });
  return data;
}

export async function writeStorage(session: CDPSession, id: string, storageArea: string, values: Record<string, unknown>): Promise<void> {
  await sendCDPCommand(session, 'Extensions.setStorageItems', { id, storageArea, values });
}

export async function removeStorage(session: CDPSession, id: string, storageArea: string, keys: string[]): Promise<void> {
  await sendCDPCommand(session, 'Extensions.removeStorageItems', { id, storageArea, keys });
}

export async function clearStorage(session: CDPSession, id: string, storageArea: string): Promise<void> {
  await sendCDPCommand(session, 'Extensions.clearStorageItems', { id, storageArea });
}
