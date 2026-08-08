document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ note: document.getElementById('note').value });
  document.getElementById('surface').textContent = 'saved';
});
