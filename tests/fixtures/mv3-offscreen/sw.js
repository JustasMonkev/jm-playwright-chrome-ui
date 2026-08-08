// Creates an offscreen document, which shows up as a chrome-extension:// target that is
// easily mistaken for the action popup.
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument())
    return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'regression fixture',
  });
}

chrome.runtime.onInstalled.addListener(ensureOffscreen);
chrome.runtime.onStartup.addListener(ensureOffscreen);
