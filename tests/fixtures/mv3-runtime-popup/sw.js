// Repointing the action at runtime is ordinary MV3: the manifest popup is only the default.
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setPopup({ popup: 'runtime.html' });
});
