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

// This banner always tracks the main periodic alarm only — retries are now
// per-marketplace (see render() below), so a failure shows inline on that
// marketplace's own row instead of hijacking this shared countdown.
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

async function render(lastResult) {
  const byMarket = {};
  if (lastResult && lastResult.results) {
    // Each result already carries its OWN `at` (set the moment that specific
    // marketplace finished) — must not be overwritten with a shared
    // "right now" timestamp, or a Myntra-only sync would make Amazon's
    // untouched, carried-over entry look freshly synced too.
    for (const r of lastResult.results) byMarket[r.marketplace] = r;
  }

  rowsEl.textContent = '';
  for (const name of ['myntra', 'amazon']) {
    const r = byMarket[name];
    const dotClass = !r ? 'unknown' : r.ok ? 'ok' : 'bad';
    let detail = !r ? 'No sync yet' : r.ok ? `Synced ${formatTime(new Date(r.at))}` : r.error;

    // A failure with its own retry pending gets that spelled out right here,
    // since retries are per-marketplace now — Myntra and Amazon can each be
    // on a completely different backoff schedule.
    if (r && !r.ok) {
      const retryAlarm = await chrome.alarms.get(`session-sync-retry-${name}`);
      if (retryAlarm) {
        const mins = Math.max(1, Math.round((retryAlarm.scheduledTime - Date.now()) / 60000));
        detail = `${r.error} — retrying in ${mins}m`;
      }
    }

    const row = document.createElement('div');
    row.className = 'row-item';

    const dot = document.createElement('span');
    dot.className = `dot ${dotClass}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = name;

    const detailEl = document.createElement('span');
    detailEl.className = r && !r.ok ? 'detail bad' : 'detail';
    detailEl.title = detail;
    detailEl.textContent = detail;

    // Lets you retry just this one marketplace on demand — e.g. it just
    // failed and you fixed the login, no reason to wait for its backoff
    // timer or re-sync the other one that's already fine.
    const syncOneBtn = document.createElement('button');
    syncOneBtn.className = 'row-sync';
    syncOneBtn.textContent = '↻';
    syncOneBtn.title = `Sync ${name} now`;
    syncOneBtn.addEventListener('click', () => syncOneMarket(name, syncOneBtn));

    row.append(dot, nameEl, detailEl, syncOneBtn);
    rowsEl.appendChild(row);
  }
}

function setBusyUI(busy) {
  syncBtn.disabled = busy;
  for (const btn of rowsEl.querySelectorAll('.row-sync')) btn.disabled = busy;
}

// The single source of truth for what's on screen: whatever background.js
// last stored (it already merges per-marketplace results correctly), never
// reconstructed by hand here — every action below just triggers a sync and
// then calls this, rather than building its own {results, at} to render.
function refreshUI() {
  chrome.storage.local.get(['lastResult'], (v) => render(v.lastResult));
  renderAutoSyncState();
}

function syncOneMarket(name, btnEl) {
  setBusyUI(true);
  btnEl.textContent = '…';
  chrome.runtime.sendMessage({ type: 'sync-now', marketplace: name }, () => {
    refreshUI();
    setBusyUI(false);
  });
}

refreshUI();

syncBtn.addEventListener('click', () => {
  setBusyUI(true);
  syncBtn.textContent = 'Syncing…';
  chrome.runtime.sendMessage('sync-now', () => {
    refreshUI();
    setBusyUI(false);
    syncBtn.textContent = 'Sync now';
  });
});

toggleBtn.addEventListener('click', () => {
  toggleBtn.disabled = true;
  chrome.runtime.sendMessage(toggleBtn.textContent === 'Stop auto-sync' ? 'stop-auto-sync' : 'start-auto-sync', () => {
    refreshUI();
    toggleBtn.disabled = false;
  });
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
