chrome.action.onClicked.addListener(tab => {
  chrome.action.setBadgeText({ tabId: tab.id, text: '1' });
});
