const statusEl = document.getElementById('status');

function render(lastResult) {
  if (!lastResult || !lastResult.results) {
    statusEl.textContent = 'No sync yet — click "Sync now", or make sure Setup is filled in.';
    return;
  }
  const when = lastResult.at ? new Date(lastResult.at).toLocaleString() : '';
  const lines = lastResult.results.map((r) =>
    r.ok ? `✓ ${r.marketplace}: synced (${r.headerCount} headers)` : `✗ ${r.marketplace}: ${r.error}`
  );
  statusEl.textContent = `${when}\n${lines.join('\n')}`;
}

chrome.storage.local.get(['lastResult'], (v) => render(v.lastResult));

document.getElementById('sync').addEventListener('click', () => {
  statusEl.textContent = 'Syncing…';
  chrome.runtime.sendMessage('sync-now', (results) => render({ results, at: new Date().toISOString() }));
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
