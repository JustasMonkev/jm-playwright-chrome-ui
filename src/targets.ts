import type { CDPSession, Page } from 'playwright-core';

import { sendCDPCommand } from './cdp';
import type { TargetInfo } from './types';

// How long to wait for a tab target to report the page it hosts. The event normally arrives in
// single-digit milliseconds; this only bounds the pathological case.
const kOwnershipTimeout = 500;

/**
 * Extensions.triggerAction only accepts a `tab` target — Chrome rejects a `page` target with
 * "Action can only be triggered on a tab target." A tab target and the page target it hosts
 * share no identifying field, so ask Chrome which page each tab owns.
 */
export async function tabTargetIdForPage(session: CDPSession, page: Page): Promise<string> {
  await page.bringToFront();
  const pageTargetId = await pageTargetIdFor(page);

  for (const tab of await tabTargets(session)) {
    if (await tabOwnsPageTarget(session, tab.targetId, pageTargetId))
      return tab.targetId;
  }

  throw new Error(`Could not find the Chrome tab target for page "${page.url()}". The page may have been closed, or it may not be a tab (extension popups and devtools windows are not tabs).`);
}

/** Targets serving a document from the extension's own origin, excluding duplicate tab entries. */
export async function extensionDocumentTargets(session: CDPSession, extensionId: string): Promise<TargetInfo[]> {
  const { targetInfos } = await sendCDPCommand<{ targetInfos: TargetInfo[] }>(session, 'Target.getTargets', {
    filter: [{}],
  });
  const prefix = `chrome-extension://${extensionId}/`;
  return targetInfos.filter(target => target.url.startsWith(prefix) && isDocumentTarget(target));
}

/**
 * A service worker is not a document, and Chrome reports offscreen documents as
 * `background_page`. Both live under the extension's origin, so matching on the URL prefix alone
 * mistakes them for the action popup — especially under MV3, where the worker is restarted on
 * demand and offscreen documents are created lazily.
 */
function isDocumentTarget(target: TargetInfo): boolean {
  return target.type === 'page';
}

async function pageTargetIdFor(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await sendCDPCommand<{ targetInfo: TargetInfo }>(session, 'Target.getTargetInfo');
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function tabTargets(session: CDPSession): Promise<TargetInfo[]> {
  const { targetInfos } = await sendCDPCommand<{ targetInfos: TargetInfo[] }>(session, 'Target.getTargets', {
    filter: [{ type: 'tab' }],
  });
  return targetInfos;
}

// Target.autoAttachRelated takes the tab as a parameter rather than requiring a command to be
// sent on the tab's own session, which Playwright's CDPSession cannot address.
async function tabOwnsPageTarget(session: CDPSession, tabTargetId: string, pageTargetId: string): Promise<boolean> {
  const attachedSessionIds: string[] = [];
  let reportOwnedPage: (targetId: string | undefined) => void = () => {};
  const ownedPage = new Promise<string | undefined>(resolve => {
    reportOwnedPage = resolve;
  });

  const onAttached = (event: any) => {
    if (event.sessionId)
      attachedSessionIds.push(event.sessionId);
    if (event.targetInfo?.type === 'page')
      reportOwnedPage(event.targetInfo.targetId);
  };

  session.on('Target.attachedToTarget' as any, onAttached);
  let timer: NodeJS.Timeout | undefined;
  try {
    await sendCDPCommand(session, 'Target.autoAttachRelated', {
      targetId: tabTargetId,
      waitForDebuggerOnStart: false,
    });
    const timedOut = new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), kOwnershipTimeout);
    });
    return await Promise.race([ownedPage, timedOut]) === pageTargetId;
  } finally {
    if (timer)
      clearTimeout(timer);
    session.off('Target.attachedToTarget' as any, onAttached);
    // Leaving these attached would keep debugger sessions alive for every tab we probed.
    for (const sessionId of attachedSessionIds)
      await sendCDPCommand(session, 'Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}
