chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === 'ping')
    sendResponse('ready');
});
