import type { CDPSession, Page } from 'playwright-core';

import { sendCDPCommand } from './cdp';
import type { TargetInfo } from './types';

// How long to wait for a tab target to report the page it hosts. The event normally arrives in
// single-digit milliseconds; this only bounds the pathological case.
const kOwnershipTimeout = 500;
// After a tab reports a page that is not the one we want, how long to keep listening in case it
// owns another.
const kSettleDelay = 15;

/**
 * Extensions.triggerAction only accepts a `tab` target — Chrome rejects a `page` target with
 * "Action can only be triggered on a tab target." A tab target and the page target it hosts
 * share no identifying field, so ask Chrome which page each tab owns.
 */
export async function tabTargetIdForPage(session: CDPSession, page: Page): Promise<string> {
  await page.bringToFront();
  const pageTarget = await pageTargetInfoFor(page);

  // Probing costs a round trip per tab, and a tab that owns no page target (an offscreen
  // document's tab, for one) costs the whole ownership timeout. URL and title cannot identify
  // the tab on their own, but they order the candidates well enough that the real one is
  // almost always probed first.
  for (const tab of byLikelihood(await tabTargets(session), pageTarget)) {
    if (await tabOwnsPageTarget(session, tab.targetId, pageTarget.targetId))
      return tab.targetId;
  }

  throw new Error(`Could not find the Chrome tab target for page "${page.url()}". The page may have been closed, or it may not be a tab (extension popups and devtools windows are not tabs).`);
}

function byLikelihood(tabs: TargetInfo[], pageTarget: TargetInfo): TargetInfo[] {
  const rank = (tab: TargetInfo) =>
    (tab.url === pageTarget.url ? 2 : 0) +
    (tab.title === pageTarget.title ? 1 : 0);
  return [...tabs].sort((left, right) => rank(right) - rank(left));
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

async function pageTargetInfoFor(page: Page): Promise<TargetInfo> {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await sendCDPCommand<{ targetInfo: TargetInfo }>(session, 'Target.getTargetInfo');
    return targetInfo;
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

// Target.autoAttachRelated takes the tab as a parameter rather than requiring the command to be
// sent on the tab's own session, which Playwright's CDPSession cannot address.
//
// A tab normally owns exactly one page target, but it can own more (a prerendered page, for
// instance), so settle briefly after the first one arrives rather than judging by whichever
// attaches first.
async function tabOwnsPageTarget(session: CDPSession, tabTargetId: string, pageTargetId: string): Promise<boolean> {
  const attachedSessionIds: string[] = [];
  let owned = false;
  let reportSettled: () => void = () => {};
  const settled = new Promise<void>(resolve => {
    reportSettled = resolve;
  });

  let settleTimer: NodeJS.Timeout | undefined;
  const onAttached = (event: any) => {
    if (event.sessionId)
      attachedSessionIds.push(event.sessionId);
    if (event.targetInfo?.type !== 'page')
      return;
    if (event.targetInfo.targetId === pageTargetId) {
      owned = true;
      reportSettled();
      return;
    }
    clearTimeout(settleTimer);
    settleTimer = setTimeout(reportSettled, kSettleDelay);
  };

  session.on('Target.attachedToTarget' as any, onAttached);
  let deadlineTimer: NodeJS.Timeout | undefined;
  try {
    await sendCDPCommand(session, 'Target.autoAttachRelated', {
      targetId: tabTargetId,
      waitForDebuggerOnStart: false,
      filter: [{ type: 'page' }],
    });
    const timedOut = new Promise<void>(resolve => {
      deadlineTimer = setTimeout(resolve, kOwnershipTimeout);
    });
    await Promise.race([settled, timedOut]);
    return owned;
  } finally {
    clearTimeout(settleTimer);
    clearTimeout(deadlineTimer);
    session.off('Target.attachedToTarget' as any, onAttached);
    // Leaving these attached would keep a debugger session alive for every tab we probed.
    for (const sessionId of attachedSessionIds)
      await sendCDPCommand(session, 'Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}
