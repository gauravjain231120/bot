// Runs in the background (a Manifest V3 service worker) and, on a timer,
// reads the Myntra + Amazon session cookies straight out of Chrome's cookie
// jar — including the HttpOnly ones a normal page script could never see —
// and sends them to the order-alert app's sync endpoint. This only ever
// reads cookies that already exist because you're logged into these sites
// normally in this browser; it never logs in or touches a password.

const SYNC_ALARM = 'session-sync';
const SYNC_RETRY_ALARM = 'session-sync-retry';
const SYNC_PERIOD_MINUTES = 240; // every 4 hours

// Backoff for retrying a failed *unattended* sync (e.g. the alarm fired while
// offline): 1m, 2m, 4m, 8m, then holds at 15m until it succeeds — instead of
// leaving the extension stuck waiting out the rest of the 4-hour period.
const RETRY_DELAYS_MINUTES = [1, 2, 4, 8, 15];

const MARKETPLACES = [
  {
    marketplace: 'myntra',
    cookieDomain: 'myntrainfo.com',
    staticHeaders: {
      accept: 'application/json, text/plain, */*',
      'x-myntra-app-name': 'mdirect',
      'x-myntra-client-id': 'mdirect',
      'x-myntra-mdirect-service': 'genie.orders.getOpenOrdersV2',
      'x-requested-with': 'XMLHttpRequest',
    },
  },
  {
    marketplace: 'amazon',
    cookieDomain: 'amazon.in',
    staticHeaders: {
      accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
    },
  },
];

async function getConfig() {
  const { appUrl, syncSecret } = await chrome.storage.local.get(['appUrl', 'syncSecret']);
  return { appUrl: (appUrl || '').replace(/\/+$/, ''), syncSecret: syncSecret || '' };
}

async function setLastResult(results) {
  await chrome.storage.local.set({ lastResult: { results, at: new Date().toISOString() } });
}

async function buildHeaders({ cookieDomain, staticHeaders }) {
  const cookies = await chrome.cookies.getAll({ domain: cookieDomain });
  if (cookies.length === 0) {
    throw new Error(`No cookies found for ${cookieDomain} — log in there in this browser first.`);
  }
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return { cookie: cookieHeader, 'user-agent': navigator.userAgent, ...staticHeaders };
}

async function syncOne(entry, appUrl, syncSecret) {
  try {
    const headers = await buildHeaders(entry);
    const res = await fetch(`${appUrl}/api/session/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace: entry.marketplace, headers }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok
      ? { marketplace: entry.marketplace, ok: true, headerCount: data.headerCount }
      : { marketplace: entry.marketplace, ok: false, error: data.error || `HTTP ${res.status}` };
  } catch (err) {
    return { marketplace: entry.marketplace, ok: false, error: err.message };
  }
}

async function syncNow() {
  const { appUrl, syncSecret } = await getConfig();
  if (!appUrl || !syncSecret) {
    const results = [{ marketplace: 'all', ok: false, error: 'Not configured yet — open the extension options.' }];
    await setLastResult(results);
    return results;
  }

  const results = await Promise.all(MARKETPLACES.map((entry) => syncOne(entry, appUrl, syncSecret)));
  await setLastResult(results);
  return results;
}

// Whether auto-sync (the alarm) should be running — the "Sync now" button in
// the popup always works regardless of this, since that's an explicit action;
// this only governs the unattended timer. Defaults to on for anyone who never
// touches the new Stop/Start button.
async function isEnabled() {
  const { autoSyncEnabled } = await chrome.storage.local.get(['autoSyncEnabled']);
  return autoSyncEnabled !== false;
}

// Re-creating the alarm unconditionally on every startup would reset its
// countdown back to full every time Chrome (re)opens, even if the countdown
// hadn't finished yet — wiping out the time already elapsed for no reason.
// Only create it if it doesn't already exist (or its period changed in code);
// otherwise leave the existing one completely alone.
//
// chrome.alarms persists its real scheduled time across a full browser
// restart on its own — Chrome fires it shortly after startup if that time
// already passed while closed (session was overdue → syncs right away), or
// simply keeps waiting until that original time if it hadn't (countdown
// continues exactly where it left off, uninterrupted by the restart). So
// onStartup must NOT force a sync itself, or it would fire early and cut a
// still-running countdown short.
async function ensureAlarm() {
  if (!(await isEnabled())) return;
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (!existing || existing.periodInMinutes !== SYNC_PERIOD_MINUTES) {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
  }
}

// How many unattended syncs in a row have failed — drives the backoff delay
// in scheduleRetry(). Lives in storage since the service worker gets killed
// and restarted between alarms and can't keep this in memory.
async function getRetryCount() {
  const { retryCount } = await chrome.storage.local.get(['retryCount']);
  return retryCount || 0;
}

async function scheduleRetry() {
  const count = await getRetryCount();
  const delayInMinutes = RETRY_DELAYS_MINUTES[Math.min(count, RETRY_DELAYS_MINUTES.length - 1)];
  await chrome.storage.local.set({ retryCount: count + 1 });
  chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes });
}

async function clearRetry() {
  await chrome.alarms.clear(SYNC_RETRY_ALARM);
  await chrome.storage.local.set({ retryCount: 0 });
}

// Runs a sync triggered by the timer (the periodic alarm or a backoff retry)
// rather than an explicit "Sync now" click. On failure this arms a short
// backoff retry so a sync that missed its slot (no internet at the time,
// a transient network error, etc.) catches up on its own instead of sitting
// stuck until the next full 4-hour period. "Not configured" is excluded —
// that needs the user to open the options page, not more retries.
async function runAutoSync() {
  const results = await syncNow();
  const isUnconfigured = results.length === 1 && results[0].marketplace === 'all';
  const failed = results.some((r) => !r.ok);
  if (failed && !isUnconfigured && (await isEnabled())) {
    await scheduleRetry();
  } else {
    await clearRetry();
  }
  return results;
}

async function startAutoSync() {
  await chrome.storage.local.set({ autoSyncEnabled: true });
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
  return runAutoSync();
}

async function stopAutoSync() {
  await chrome.storage.local.set({ autoSyncEnabled: false });
  await chrome.alarms.clear(SYNC_ALARM);
  await clearRetry();
}

// Fresh install: no prior countdown exists yet, so sync right away instead of
// making the very first sync wait a full period.
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  isEnabled().then((on) => on && runAutoSync());
});
// Browser restart: only make sure the alarm still exists — never force a sync
// here (see the comment on ensureAlarm above for why).
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM || alarm.name === SYNC_RETRY_ALARM) runAutoSync();
});

// If the service worker happens to be alive when connectivity comes back,
// jump the queue instead of waiting out the rest of the backoff delay. Only
// fires when a retry is actually pending, so a healthy cycle never gets an
// extra sync just because the network blipped.
self.addEventListener('online', () => {
  chrome.alarms.get(SYNC_RETRY_ALARM).then((alarm) => {
    if (alarm) runAutoSync();
  });
});

// Lets the popup trigger an immediate sync, or toggle auto-sync, and read the
// result back.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === 'sync-now') {
    syncNow().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (message === 'stop-auto-sync') {
    stopAutoSync().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message === 'start-auto-sync') {
    startAutoSync().then((results) => sendResponse({ ok: true, results }));
    return true;
  }
});
