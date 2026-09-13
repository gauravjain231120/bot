const countdownEl = document.getElementById('countdown');
const countdownLabelEl = document.getElementById('countdownLabel');
const rowsEl = document.getElementById('rows');
const toggleBtn = document.getElementById('toggle');
const syncBtn = document.getElementById('sync');

let nextSyncAt = null; // ms epoch, or null when stopped/unscheduled
let countdownTimer = null;

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

function formatCountdown(ms) {
  if (ms <= 0) return 'due any moment';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Ticks every second while the popup is open, recomputing from the fixed
// target time each tick (not just decrementing a counter) so it can never
// drift out of sync with the real alarm.
function tickCountdown() {
  countdownEl.textContent = nextSyncAt ? formatCountdown(nextSyncAt - Date.now()) : '—';
}

function startCountdownTimer() {
  clearInterval(countdownTimer);
  tickCountdown();
  countdownTimer = setInterval(tickCountdown, 1000);
}

async function renderAutoSyncState() {
  const { autoSyncEnabled } = await chrome.storage.local.get(['autoSyncEnabled']);
  const on = autoSyncEnabled !== false;
  toggleBtn.textContent = on ? 'Stop auto-sync' : 'Start auto-sync';
  countdownEl.classList.toggle('stopped', !on);

  if (!on) {
    countdownLabelEl.textContent = 'Auto-sync is stopped';
    nextSyncAt = null;
    clearInterval(countdownTimer);
    tickCountdown();
    return;
  }
  countdownLabelEl.textContent = 'Next auto-sync in';
  const alarm = await chrome.alarms.get('session-sync');
  nextSyncAt = alarm ? alarm.scheduledTime : null;
  startCountdownTimer();
}

function render(lastResult) {
  const byMarket = {};
  if (lastResult && lastResult.results) {
    for (const r of lastResult.results) byMarket[r.marketplace] = { ...r, at: lastResult.at };
  }

  rowsEl.textContent = '';
  for (const name of ['myntra', 'amazon']) {
    const r = byMarket[name];
    const dotClass = !r ? 'unknown' : r.ok ? 'ok' : 'bad';
    const detail = !r ? 'No sync yet' : r.ok ? `Synced ${formatTime(new Date(r.at))}` : r.error;

    const row = document.createElement('div');
    row.className = 'row-item';

    const dot = document.createElement('span');
    dot.className = `dot ${dotClass}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = name;

    const detailEl = document.createElement('span');
    detailEl.className = 'detail';
    detailEl.title = detail;
    detailEl.textContent = detail;

    row.append(dot, nameEl, detailEl);
    rowsEl.appendChild(row);
  }
}

chrome.storage.local.get(['lastResult'], (v) => render(v.lastResult));
renderAutoSyncState();

syncBtn.addEventListener('click', () => {
  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing…';
  chrome.runtime.sendMessage('sync-now', (results) => {
    render({ results, at: new Date().toISOString() });
    renderAutoSyncState();
    syncBtn.disabled = false;
    syncBtn.textContent = 'Sync now';
  });
});

toggleBtn.addEventListener('click', () => {
  const stopping = toggleBtn.textContent === 'Stop auto-sync';
  toggleBtn.disabled = true;
  chrome.runtime.sendMessage(stopping ? 'stop-auto-sync' : 'start-auto-sync', (res) => {
    if (!stopping && res && res.results) render({ results: res.results, at: new Date().toISOString() });
    renderAutoSyncState();
    toggleBtn.disabled = false;
  });
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
