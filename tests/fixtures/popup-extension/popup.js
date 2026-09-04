const button = document.querySelector('button');
const activeURL = document.querySelector('[data-active-url]');
const workerStatus = document.querySelector('[data-worker-status]');

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  activeURL.textContent = tab?.url ?? 'unavailable';
});

chrome.runtime.sendMessage('ping').then(response => {
  workerStatus.textContent = response;
});

button.addEventListener('click', () => {
  const count = Number(button.dataset.count) + 1;
  button.dataset.count = String(count);
  button.textContent = `Clicks: ${count}`;
});
