"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  listExtensions: () => listExtensions,
  openExtension: () => openExtension,
  triggerExtensionAction: () => triggerExtensionAction
});
module.exports = __toCommonJS(index_exports);

// src/cdp.ts
function browserFrom(target) {
  if ("newBrowserCDPSession" in target)
    return target;
  if ("browser" in target) {
    const browser = target.browser();
    if (browser)
      return browser;
  }
  if ("context" in target) {
    const browser = target.context().browser();
    if (browser)
      return browser;
  }
  throw new Error("Chrome UI helpers require a Playwright Browser, BrowserContext, or Page connected to Chromium.");
}
async function withBrowserSession(browser, callback) {
  assertChromiumBrowser(browser);
  let session;
  try {
    session = await browser.newBrowserCDPSession();
  } catch (error) {
    throw new Error(`Chrome UI helpers require Chromium CDP support: ${error.message}`);
  }
  try {
    return await callback(session);
  } finally {
    await session.detach().catch(() => {
    });
  }
}
async function sendCDPCommand(session, method, params) {
  try {
    return await session.send(method, params);
  } catch (error) {
    if (method.startsWith("Extensions.") && /wasn't found|enable-unsafe-extension-debugging|not supported|not allowed/i.test(error.message))
      throw new Error(`Chrome extension UI commands require Chromium launched with --enable-unsafe-extension-debugging: ${error.message}`);
    throw error;
  }
}
function assertChromiumBrowser(browser) {
  const browserType = browser.browserType().name();
  if (browserType !== "chromium")
    throw new Error(`Chrome UI helpers only support Chromium browsers. Received "${browserType}".`);
}

// src/targets.ts
async function tabTargetIdForPage(page, browser) {
  await page.bringToFront();
  const pageTargetInfo = await pageTargetInfoFor(page);
  return await matchingTabTargetId(browser, page, pageTargetInfo);
}
async function waitForExtensionPopupURL(session, extension, existingTargetIds, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const popupURL = await newExtensionTargetURL(session, extension.id, existingTargetIds);
    if (popupURL)
      return popupURL;
    await delay(100);
  }
  throw new Error(`Extension "${extension.name}" did not open a popup within ${timeout}ms. Make sure the extension has a default action popup.`);
}
async function extensionTargets(session, extensionId) {
  const { targetInfos } = await sendCDPCommand(session, "Target.getTargets", {
    filter: [{}]
  });
  return targetInfos.filter((target) => target.url.startsWith(`chrome-extension://${extensionId}/`));
}
async function pageTargetInfoFor(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const result = await sendCDPCommand(session, "Target.getTargetInfo");
    return result.targetInfo;
  } finally {
    await session.detach().catch(() => {
    });
  }
}
async function matchingTabTargetId(browser, page, pageTargetInfo) {
  return await withBrowserSession(browser, async (session) => {
    const candidates = await tabTargets(session);
    const matches = candidates.filter((target) => matchesPageTarget(target, pageTargetInfo));
    if (matches.length === 1)
      return matches[0].targetId;
    if (!matches.length)
      throw new Error(`Could not find a Chrome tab target for page "${page.url()}".`);
    throw new Error(`Could not uniquely identify the Chrome tab target for page "${page.url()}". Make sure the page URL and title are unique among open tabs.`);
  });
}
async function tabTargets(session) {
  const { targetInfos } = await sendCDPCommand(session, "Target.getTargets", {
    filter: [{ type: "tab" }]
  });
  return targetInfos;
}
function matchesPageTarget(tabTarget, pageTarget) {
  return tabTarget.browserContextId === pageTarget.browserContextId && tabTarget.url === pageTarget.url && tabTarget.title === pageTarget.title;
}
async function newExtensionTargetURL(session, extensionId, existingTargetIds) {
  for (const target of await extensionTargets(session, extensionId)) {
    if (!existingTargetIds.has(target.targetId))
      return target.url;
  }
}
async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// src/extensions.ts
var kDefaultTimeout = 5e3;
async function listExtensions(target) {
  const browser = browserFrom(target);
  return await withBrowserSession(browser, async (session) => {
    const result = await sendCDPCommand(session, "Extensions.getExtensions");
    return result.extensions;
  });
}
async function triggerExtensionAction(page, options) {
  const browser = browserFrom(page);
  const [extension, targetId] = await Promise.all([
    resolveExtension(browser, options),
    tabTargetIdForPage(page, browser)
  ]);
  await withBrowserSession(browser, async (session) => {
    await sendCDPCommand(session, "Extensions.triggerAction", {
      id: extension.id,
      targetId
    });
  });
  return extension;
}
async function openExtension(page, options) {
  const browser = browserFrom(page);
  const [extension, targetId] = await Promise.all([
    resolveExtension(browser, options),
    tabTargetIdForPage(page, browser)
  ]);
  const timeout = options.timeout ?? kDefaultTimeout;
  const popupURL = await triggerActionAndFindPopupURL(browser, extension, targetId, timeout);
  return await pageForPopupURL(page, popupURL, timeout);
}
async function triggerActionAndFindPopupURL(browser, extension, targetId, timeout) {
  return await withBrowserSession(browser, async (session) => {
    const existingTargetIds = new Set((await extensionTargets(session, extension.id)).map((target) => target.targetId));
    await sendCDPCommand(session, "Extensions.triggerAction", {
      id: extension.id,
      targetId
    });
    return await waitForExtensionPopupURL(session, extension, existingTargetIds, timeout);
  });
}
async function pageForPopupURL(page, popupURL, timeout) {
  const existingPopup = page.context().pages().find((popup2) => popup2.url() === popupURL);
  if (existingPopup)
    return existingPopup;
  const popup = await page.context().newPage();
  await popup.goto(popupURL, { waitUntil: "domcontentloaded", timeout });
  return popup;
}
async function resolveExtension(browser, selector) {
  const extensions = await listExtensions(browser);
  const matches = extensions.filter((extension) => matchesSelector(extension, selector));
  if (!matches.length)
    throw new Error(`No Chrome extension matches the selector. Available extensions: ${formatExtensions(extensions)}`);
  if (matches.length > 1)
    throw new Error(`Chrome extension selector matched multiple extensions: ${formatExtensions(matches)}`);
  return matches[0];
}
function matchesSelector(extension, selector) {
  if (selector.id && extension.id !== selector.id)
    return false;
  if (selector.name && !matchesName(extension.name, selector.name))
    return false;
  return !!selector.id || !!selector.name;
}
function matchesName(extensionName, selectorName) {
  if (typeof selectorName === "string")
    return extensionName === selectorName;
  return selectorName.test(extensionName);
}
function formatExtensions(extensions) {
  return extensions.map((extension) => `${extension.name} (${extension.id})`).join(", ") || "none";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  listExtensions,
  openExtension,
  triggerExtensionAction
});
