// No default_popup, so clicking the toolbar action dispatches here. Creating an offscreen
// document in response is a common MV3 pattern, and it produces a fresh chrome-extension://
// target that must not be mistaken for an action popup.
chrome.action.onClicked.addListener(async () => {
  await chrome.storage.local.set({ clicked: true });
  if (await chrome.offscreen.hasDocument())
    return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'regression fixture',
  });
});
