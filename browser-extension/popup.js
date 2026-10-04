const watchEl = document.getElementById('watch');
const rowsEl = document.getElementById('rows');
const toggleBtn = document.getElementById('toggle');
const syncBtn = document.getElementById('sync');
const periodInputs = { myntra: document.getElementById('periodMyntra'), amazon: document.getElementById('periodAmazon'), flipkart: document.getElementById('periodFlipkart') };
const periodHuman = { myntra: document.getElementById('periodMyntraHuman'), amazon: document.getElementById('periodAmazonHuman'), flipkart: document.getElementById('periodFlipkartHuman') };
const saveBtn = document.getElementById('savePeriods');
const saveStatus = document.getElementById('saveStatus');
const periodHint = document.getElementById('periodHint');

const NAMES = ['myntra', 'amazon', 'flipkart'];
const LABEL = { myntra: 'Myntra', amazon: 'Amazon', flipkart: 'Flipkart' };

let nextAt = {}; // marketplace -> ms epoch of its next scheduled sync
let enabled = true;

// Always 12-hour (e.g. "13 Sep, 6:47 pm") regardless of the system's locale default.
function formatTime(date) {
  return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatCountdown(ms) {
  if (ms <= 0) return 'due any moment';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function humanPeriod(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n % 60 === 0) return `= ${n / 60}h`;
  return n > 60 ? `= ${Math.floor(n / 60)}h ${n % 60}m` : '';
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return formatTime(new Date(iso));
}

// Recomputed from fixed target times every second (never a decrementing
// counter), so it can't drift from the real alarms.
function tick() {
  for (const name of NAMES) {
    const el = document.getElementById(`next-${name}`);
    if (!el) continue;
    el.textContent = !enabled ? 'Auto-sync stopped' : nextAt[name] ? `Next sync in ${formatCountdown(nextAt[name] - Date.now())}` : '';
  }
}

async function renderWatch() {
  const { autoSyncEnabled, health } = await chrome.storage.local.get(['autoSyncEnabled', 'health']);
  enabled = autoSyncEnabled !== false;
  toggleBtn.textContent = enabled ? 'Stop auto-sync' : 'Start auto-sync';
  watchEl.textContent = '';
  if (!enabled) {
    watchEl.textContent = 'Auto-sync is stopped — the session watch is off too.';
    return;
  }
  if (!health) {
    watchEl.textContent = 'Checking the bot every minute… (first check shortly)';
    return;
  }
  if (health.error) {
    const bad = document.createElement('span');
    bad.className = 'bad';
    bad.textContent = health.error;
    watchEl.append(bad, ` · ${ago(health.at)}`);
    return;
  }
  const parts = NAMES.map((n) => {
    const st = health[n] && health[n].state;
    const span = document.createElement('span');
    span.className = st === 'ok' ? 'good' : st === 'expired' || st === 'missing' ? 'bad' : '';
    span.textContent = `${LABEL[n]} ${st === 'ok' ? 'OK' : st === 'expired' ? 'expired' : st === 'missing' ? 'not set up' : st === 'error' ? 'check failing' : '?'}`;
    return span;
  });
  watchEl.append('Bot: ', parts[0], ' · ', parts[1], ` — checked ${ago(health.at)}`);
  if (health.running === false) watchEl.append(' (bot checks are stopped)');
}

async function render() {
  const store = await chrome.storage.local.get(['lastResult', ...NAMES.map((n) => `recovery_${n}`)]);
  const byMarket = {};
  for (const r of (store.lastResult && store.lastResult.results) || []) byMarket[r.marketplace] = r;

  nextAt = {};
  for (const name of NAMES) {
    const alarm = await chrome.alarms.get(`session-sync-market-${name}`);
    if (alarm) nextAt[name] = alarm.scheduledTime;
  }

  rowsEl.textContent = '';
  for (const name of NAMES) {
    const r = byMarket[name] || byMarket.all;
    const rec = store[`recovery_${name}`] || {};
    let dotClass = !r ? 'unknown' : r.ok ? 'ok' : 'bad';
    let detail = !r ? 'No sync yet' : r.ok ? `Synced ${formatTime(new Date(r.at))}${r.trigger === 'recovery' ? ' (auto-restored)' : ''}` : r.error;

    if (rec.needsLogin) {
      dotClass = 'bad';
      detail = `Logged out — log in to ${LABEL[name]} in this Chrome; it will sync by itself`;
    } else if (r && !r.ok) {
      const retryAlarm = await chrome.alarms.get(`session-sync-retry-${name}`);
      if (retryAlarm) {
        const mins = Math.max(1, Math.round((retryAlarm.scheduledTime - Date.now()) / 60000));
        detail = `${r.error} — retrying in ${mins}m`;
      }
    }

    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'row-item';

    const dot = document.createElement('span');
    dot.className = `dot ${dotClass}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = name;

    const detailEl = document.createElement('span');
    detailEl.className = dotClass === 'bad' ? 'detail bad' : 'detail';
    detailEl.title = detail;
    detailEl.textContent = detail;

    const syncOneBtn = document.createElement('button');
    syncOneBtn.className = 'row-sync';
    syncOneBtn.textContent = '↻';
    syncOneBtn.title = `Sync ${name} now`;
    syncOneBtn.addEventListener('click', () => syncOneMarket(name, syncOneBtn));

    row.append(dot, nameEl, detailEl, syncOneBtn);
    const next = document.createElement('div');
    next.className = 'next';
    next.id = `next-${name}`;
    wrap.append(row, next);
    rowsEl.appendChild(wrap);
  }
  tick();
}

function setBusyUI(busy) {
  syncBtn.disabled = busy;
  for (const btn of rowsEl.querySelectorAll('.row-sync')) btn.disabled = busy;
}

async function refreshUI() {
  await renderWatch();
  await render();
}

function syncOneMarket(name, btnEl) {
  setBusyUI(true);
  btnEl.textContent = '…';
  chrome.runtime.sendMessage({ type: 'sync-now', marketplace: name }, () => {
    void chrome.runtime.lastError; // no answer = older background; nothing to do
    refreshUI();
    setBusyUI(false);
  });
}

// Same limits/default as background.js. The boxes are filled straight from
// storage (240 = 4h until you change it), so they're never blank — even if
// the background part is still an older version that doesn't answer yet.
const MIN_PERIOD = 15;
const MAX_PERIOD = 1440;
const DEFAULT_PERIOD = 240;
const clampPeriod = (v) => Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, Math.round(Number(v))));
let backgroundUpToDate = true;

async function loadPeriods() {
  const stored = await chrome.storage.local.get(NAMES.map((n) => `syncPeriod_${n}`));
  for (const n of NAMES) {
    const v = stored[`syncPeriod_${n}`] ? clampPeriod(stored[`syncPeriod_${n}`]) : DEFAULT_PERIOD;
    periodInputs[n].value = v;
    periodInputs[n].min = MIN_PERIOD;
    periodInputs[n].max = MAX_PERIOD;
    periodHuman[n].textContent = humanPeriod(v);
  }
  periodHint.textContent = `${MIN_PERIOD}–${MAX_PERIOD} minutes. Default ${DEFAULT_PERIOD} (4 hours).`;
  // An older background (before 1.1) doesn't answer this — then the new
  // timers/health watch aren't running yet and the extension needs a reload.
  chrome.runtime.sendMessage('get-periods', (res) => {
    void chrome.runtime.lastError;
    backgroundUpToDate = !!(res && res.periods);
    showReloadNote();
  });
}

function showReloadNote() {
  let el = document.getElementById('reloadNote');
  if (backgroundUpToDate) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'reloadNote';
    el.className = 'watch';
    el.style.cssText = 'color:#dc2626;font-weight:600;margin-top:6px';
    watchEl.parentElement.appendChild(el);
  }
  el.textContent = 'Update not finished: open chrome://extensions and click ⟳ Reload on this extension.';
}

for (const n of NAMES) {
  periodInputs[n].addEventListener('input', () => {
    periodHuman[n].textContent = humanPeriod(periodInputs[n].value);
    saveStatus.textContent = '';
  });
}

saveBtn.addEventListener('click', () => {
  const periods = {};
  for (const n of NAMES) {
    const v = Number(periodInputs[n].value);
    if (!Number.isFinite(v) || v <= 0) {
      saveStatus.style.color = 'var(--bad)';
      saveStatus.textContent = `Enter a number of minutes for ${LABEL[n]}.`;
      return;
    }
    periods[n] = v;
  }
  saveBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'set-periods', periods }, async (res) => {
    void chrome.runtime.lastError;
    saveBtn.disabled = false;
    if (!res || !res.ok) {
      // Older background: still save the numbers, so they apply the moment
      // the extension is reloaded.
      const clamped = Object.fromEntries(NAMES.map((n) => [n, clampPeriod(periods[n])]));
      await chrome.storage.local.set(Object.fromEntries(NAMES.map((n) => [`syncPeriod_${n}`, clamped[n]])));
      for (const n of NAMES) {
        periodInputs[n].value = clamped[n];
        periodHuman[n].textContent = humanPeriod(clamped[n]);
      }
      saveStatus.style.color = 'var(--bad)';
      saveStatus.textContent = 'Saved — reload the extension (chrome://extensions → ⟳) for it to take effect.';
      return;
    }
    for (const n of NAMES) {
      periodInputs[n].value = res.periods[n];
      periodHuman[n].textContent = humanPeriod(res.periods[n]);
    }
    saveStatus.style.color = 'var(--good)';
    saveStatus.textContent = `Saved ✓ Myntra every ${res.periods.myntra} min, Amazon every ${res.periods.amazon} min, Flipkart every ${res.periods.flipkart} min.`;
    refreshUI();
  });
});

refreshUI();
loadPeriods();
// Just render cached health data — the background 5-minute alarm handles
// actual checks. No extra Vercel call on every popup open.
renderWatch().then(showReloadNote);
setInterval(tick, 1000);
// Keep the "ago" text fresh while the popup stays open.
setInterval(renderWatch, 15000);

syncBtn.addEventListener('click', () => {
  setBusyUI(true);
  syncBtn.textContent = 'Syncing…';
  chrome.runtime.sendMessage('sync-now', () => {
    void chrome.runtime.lastError;
    refreshUI();
    setBusyUI(false);
    syncBtn.textContent = 'Sync now';
  });
});

toggleBtn.addEventListener('click', () => {
  toggleBtn.disabled = true;
  chrome.runtime.sendMessage(toggleBtn.textContent === 'Stop auto-sync' ? 'stop-auto-sync' : 'start-auto-sync', () => {
    void chrome.runtime.lastError;
    refreshUI();
    toggleBtn.disabled = false;
  });
});

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});





const localFlipkartEl = document.getElementById('localFlipkart');
const localMyntraEl = document.getElementById('localMyntra');
const localAmazonEl = document.getElementById('localAmazon');
const proxyPeriodAmzEl = document.getElementById('proxyPeriodAmz');
const proxyPeriodMynEl = document.getElementById('proxyPeriodMyn');
const proxyPeriodFkEl = document.getElementById('proxyPeriodFk');
const localCheckStatus = document.getElementById('localCheckStatus');

async function loadLocalCheck() {
  const stored = await chrome.storage.local.get(['localMyntra', 'localAmazon', 'localFlipkart', 'proxyPeriodAmazon', 'proxyPeriodMyntra', 'proxyPeriodFlipkart']);
  if (localMyntraEl) localMyntraEl.checked = !!stored.localMyntra;
  if (localAmazonEl) localAmazonEl.checked = !!stored.localAmazon;
  if (proxyPeriodAmzEl) proxyPeriodAmzEl.value = stored.proxyPeriodAmazon || 5;
  if (proxyPeriodMynEl) proxyPeriodMynEl.value = stored.proxyPeriodMyntra || 2;
  if (localFlipkartEl) localFlipkartEl.checked = !!stored.localFlipkart;
  if (proxyPeriodFkEl) proxyPeriodFkEl.value = stored.proxyPeriodFlipkart || 5;
}
loadLocalCheck();

function handleLocalCheckChange(e) {
  const pAmz = Math.max(1, parseInt(proxyPeriodAmzEl.value) || 5);
  const pMyn = Math.max(1, parseInt(proxyPeriodMynEl.value) || 2);
  const pFk = Math.max(1, parseInt(proxyPeriodFkEl ? proxyPeriodFkEl.value : 5) || 5);
  
  const isAmz = !!localAmazonEl.checked;
  const isMyn = !!localMyntraEl.checked;
  const isFk = !!(localFlipkartEl && localFlipkartEl.checked);

  chrome.storage.local.set({
    localMyntra: isMyn,
    localAmazon: isAmz,
    localFlipkart: isFk,
    proxyPeriodAmazon: pAmz,
    proxyPeriodMyntra: pMyn,
    proxyPeriodFlipkart: pFk
  }, () => {
    chrome.runtime.sendMessage({ type: 'update-proxy-alarms' });
    
    // Instant Mode Switch Triggers (Only if toggle was clicked, skip if just interval changed)
    if (e && e.target && e.target.id === 'localAmazon') {
      chrome.runtime.sendMessage({ type: 'manual-mode-switch', marketplace: 'amazon', mode: isAmz ? 'local' : 'cloud' });
    } else if (e && e.target && e.target.id === 'localFlipkart') {
      chrome.runtime.sendMessage({ type: 'manual-mode-switch', marketplace: 'flipkart', mode: isFk ? 'local' : 'cloud' });
    } else if (e && e.target && e.target.id === 'localMyntra') {
      chrome.runtime.sendMessage({ type: 'manual-mode-switch', marketplace: 'myntra', mode: isMyn ? 'local' : 'cloud' });
    }
  });

  localCheckStatus.style.color = 'var(--good)';
  localCheckStatus.textContent = 'Saved. Check Engine updated.';
  setTimeout(() => { localCheckStatus.textContent = ''; }, 2000);
}

if (localFlipkartEl) localFlipkartEl.addEventListener('change', handleLocalCheckChange);
if (localMyntraEl) localMyntraEl.addEventListener('change', handleLocalCheckChange);
if (localAmazonEl) localAmazonEl.addEventListener('change', handleLocalCheckChange);
if (proxyPeriodAmzEl) proxyPeriodAmzEl.addEventListener('input', handleLocalCheckChange);
if (proxyPeriodMynEl) proxyPeriodMynEl.addEventListener('input', handleLocalCheckChange);
if (proxyPeriodFkEl) proxyPeriodFkEl.addEventListener('input', handleLocalCheckChange);

function wireTestButton(btnId, type, marketplace, resId) {
  const btn = document.getElementById(btnId);
  const resEl = document.getElementById(resId);
  if (!btn || !resEl) return;
  
  btn.addEventListener('click', () => {
    btn.disabled = true;
    resEl.style.color = 'var(--muted)';
    resEl.textContent = 'Testing...';
    
    chrome.runtime.sendMessage({ type, marketplace }, (res) => {
      btn.disabled = false;
      if (!res) {
        resEl.style.color = 'var(--bad)';
        resEl.textContent = 'Extension error';
        return;
      }
      
      if (res.ok) {
        resEl.style.color = 'var(--good)';
        resEl.textContent = `✅ Success: ${res.count} orders (${type === 'test-local' ? 'Local' : 'Cloud'})`;
      } else {
        resEl.style.color = 'var(--bad)';
        resEl.textContent = `❌ Failed: ${res.message || res.error || 'Unknown error'}`;
      }
    });
  });
}

wireTestButton('testAmzLocal', 'test-local', 'amazon', 'resAmz');
wireTestButton('testAmzCloud', 'test-cloud', 'amazon', 'resAmz');
wireTestButton('testMynLocal', 'test-local', 'myntra', 'resMyn');
wireTestButton('testMynCloud', 'test-cloud', 'myntra', 'resMyn');

wireTestButton('testFkLocal', 'test-local', 'flipkart', 'resFk');
wireTestButton('testFkCloud', 'test-cloud', 'flipkart', 'resFk');
