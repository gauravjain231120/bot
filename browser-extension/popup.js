const statusEl = document.getElementById('status');

function render(result) {
  if (!result) {
    statusEl.textContent = 'No sync yet — click "Sync now", or make sure Setup is filled in.';
    return;
  }
  const when = result.at ? new Date(result.at).toLocaleString() : '';
  statusEl.textContent = result.ok
    ? `✓ Synced at ${when}\n(${result.headerCount} headers sent)`
    : `✗ Failed at ${when}\n${result.error}`;
}

chrome.storage.local.get(['lastResult'], (v) => render(v.lastResult));

document.getElementById('sync').addEventListener('click', () => {
  statusEl.textContent = 'Syncing…';
  chrome.runtime.sendMessage('sync-now', render);
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
