const statusEl = document.getElementById('status');
const nextSyncEl = document.getElementById('nextSync');
const stopBtn = document.getElementById('stop');
const startBtn = document.getElementById('start');

// Always 12-hour (e.g. "13 Sep, 6:47 pm") regardless of the system's locale default.
function formatTime(date) {
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

async function renderAutoSyncState() {
  const { autoSyncEnabled } = await chrome.storage.local.get(['autoSyncEnabled']);
  const on = autoSyncEnabled !== false;
  stopBtn.hidden = !on;
  startBtn.hidden = on;

  if (!on) {
    nextSyncEl.textContent = 'Auto-sync is stopped.';
    return;
  }
  const alarm = await chrome.alarms.get('session-sync');
  nextSyncEl.textContent = alarm ? `Next auto-sync: ${formatTime(new Date(alarm.scheduledTime))}` : 'Next auto-sync: not scheduled yet';
}
renderAutoSyncState();

function render(lastResult) {
  if (!lastResult || !lastResult.results) {
    statusEl.textContent = 'No sync yet — click "Sync now", or make sure Setup is filled in.';
    return;
  }
  const when = lastResult.at ? formatTime(new Date(lastResult.at)) : '';
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

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage('stop-auto-sync', () => renderAutoSyncState());
});

startBtn.addEventListener('click', () => {
  statusEl.textContent = 'Syncing…';
  chrome.runtime.sendMessage('start-auto-sync', (res) => {
    render({ results: res.results, at: new Date().toISOString() });
    renderAutoSyncState();
  });
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
