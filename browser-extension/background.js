// Runs in the background (a Manifest V3 service worker) and, on a timer,
// reads the Myntra + Amazon session cookies straight out of Chrome's cookie
// jar — including the HttpOnly ones a normal page script could never see —
// and sends them to the order-alert app's sync endpoint. This only ever
// reads cookies that already exist because you're logged into these sites
// normally in this browser; it never logs in or touches a password.

const SYNC_ALARM = 'session-sync';
// One retry alarm PER marketplace (e.g. "session-sync-retry-amazon") so a
// broken Amazon session retries on its own schedule without also re-syncing
// a perfectly healthy Myntra session (and vice versa).
const RETRY_ALARM_PREFIX = 'session-sync-retry-';
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
const MARKETPLACE_NAMES = MARKETPLACES.map((m) => m.marketplace);

function retryAlarmName(marketplace) {
  return `${RETRY_ALARM_PREFIX}${marketplace}`;
}

async function getConfig() {
  const { appUrl, syncSecret } = await chrome.storage.local.get(['appUrl', 'syncSecret']);
  return { appUrl: (appUrl || '').replace(/\/+$/, ''), syncSecret: syncSecret || '' };
}

// Merges freshly-synced results into whatever's already stored rather than
// replacing the whole thing — a targeted retry only re-syncs ONE marketplace,
// and must not blank out the other's last-known (still valid) status.
async function mergeLastResult(newResults) {
  const { lastResult } = await chrome.storage.local.get(['lastResult']);
  const existing = (lastResult && lastResult.results) || [];
  const merged = newResults.length === 1 && newResults[0].marketplace === 'all'
    ? newResults
    : MARKETPLACE_NAMES.map(
        (name) => newResults.find((r) => r.marketplace === name) || existing.find((r) => r.marketplace === name)
      ).filter(Boolean);
  await chrome.storage.local.set({ lastResult: { results: merged, at: new Date().toISOString() } });
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

// Syncs only the given marketplace names (defaults to all of them).
async function syncSome(names = MARKETPLACE_NAMES) {
  const { appUrl, syncSecret } = await getConfig();
  if (!appUrl || !syncSecret) {
    const results = [{ marketplace: 'all', ok: false, error: 'Not configured yet — open the extension options.' }];
    await mergeLastResult(results);
    return results;
  }

  const entries = MARKETPLACES.filter((m) => names.includes(m.marketplace));
  const results = await Promise.all(entries.map((entry) => syncOne(entry, appUrl, syncSecret)));
  await mergeLastResult(results);
  return results;
}

async function syncNow() {
  return syncSome(MARKETPLACE_NAMES);
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

// How many unattended syncs in a row have failed for THIS marketplace —
// drives its own backoff delay in scheduleRetry(). Lives in storage since the
// service worker gets killed and restarted between alarms and can't keep
// this in memory.
async function getRetryCount(marketplace) {
  const key = `retryCount_${marketplace}`;
  const stored = await chrome.storage.local.get([key]);
  return stored[key] || 0;
}

async function scheduleRetry(marketplace) {
  const count = await getRetryCount(marketplace);
  const delayInMinutes = RETRY_DELAYS_MINUTES[Math.min(count, RETRY_DELAYS_MINUTES.length - 1)];
  await chrome.storage.local.set({ [`retryCount_${marketplace}`]: count + 1 });
  chrome.alarms.create(retryAlarmName(marketplace), { delayInMinutes });
}

async function clearRetry(marketplace) {
  await chrome.alarms.clear(retryAlarmName(marketplace));
  await chrome.storage.local.set({ [`retryCount_${marketplace}`]: 0 });
}

async function pendingRetries() {
  const alarms = await chrome.alarms.getAll();
  return alarms.filter((a) => a.name.startsWith(RETRY_ALARM_PREFIX));
}

// Shared by runAutoSync and the manual "Sync now" handler: each marketplace
// that succeeded (or that shouldn't retry because auto-sync is off) has its
// retry cleared; each that's still failing arms its own backoff.
async function updateRetriesFor(results, enabled) {
  for (const r of results) {
    if (r.ok || !enabled) await clearRetry(r.marketplace);
    else await scheduleRetry(r.marketplace);
  }
}

// Red "!" on the toolbar icon while ANY marketplace has a retry pending, so a
// failure is visible without opening the popup. Badge state is drawn by
// Chrome itself and survives the service worker going to sleep, so this only
// needs to run whenever a retry alarm is armed or cleared, not on a timer.
async function updateBadge() {
  const pending = await pendingRetries();
  if (pending.length > 0) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Runs a sync triggered by the timer (the periodic alarm or a per-marketplace
// backoff retry) rather than an explicit "Sync now" click, for just the given
// marketplace names. On failure EACH marketplace arms its own short backoff
// retry so a sync that missed its slot (no internet at the time, a transient
// network error, that marketplace's session being stale, etc.) catches up on
// its own instead of sitting stuck until the next full 4-hour period — and a
// marketplace that's already fine is never dragged along for the ride.
// "Not configured" is excluded — that needs the user to open the options
// page, not more retries.
async function runAutoSync(names = MARKETPLACE_NAMES) {
  const results = await syncSome(names);
  const isUnconfigured = results.length === 1 && results[0].marketplace === 'all';
  if (isUnconfigured) {
    // Clear any retry already pending for these — a config problem isn't
    // something a per-marketplace backoff can fix, and leaving one armed
    // would just have it fire forever hitting this same branch every time.
    for (const name of names) await clearRetry(name);
    await updateBadge();
    return results;
  }
  await updateRetriesFor(results, await isEnabled());
  await updateBadge();
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
  for (const name of MARKETPLACE_NAMES) await clearRetry(name);
  await updateBadge();
}

// Fresh install: no prior countdown exists yet, so sync right away instead of
// making the very first sync wait a full period.
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  isEnabled().then((on) => on && runAutoSync());
});
// Browser restart: only make sure the alarm still exists — never force a sync
// here (see the comment on ensureAlarm above for why). Per-marketplace retry
// alarms (if any) survive the restart on their own; just make the badge
// match them again, since Chrome doesn't persist badge text across a restart.
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    runAutoSync();
  } else if (alarm.name.startsWith(RETRY_ALARM_PREFIX)) {
    runAutoSync([alarm.name.slice(RETRY_ALARM_PREFIX.length)]);
  }
});

// If the service worker happens to be alive when connectivity comes back,
// jump the queue instead of waiting out the rest of the backoff delay — for
// whichever marketplace(s) actually have a retry pending. Only fires when at
// least one does, so a healthy cycle never gets an extra sync just because
// the network blipped.
self.addEventListener('online', () => {
  pendingRetries().then((alarms) => {
    if (alarms.length > 0) runAutoSync(alarms.map((a) => a.name.slice(RETRY_ALARM_PREFIX.length)));
  });
});

// Lets the popup trigger an immediate sync, or toggle auto-sync, and read the
// result back.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === 'sync-now') {
    syncNow().then(async (results) => {
      const isUnconfigured = results.length === 1 && results[0].marketplace === 'all';
      if (!isUnconfigured) {
        const enabled = await isEnabled();
        // A marketplace that succeeds here while it had a retry pending
        // (e.g. you noticed the badge and logged back in) counts as recovery
        // too — no reason to make it wait for the backoff alarm as well. One
        // that's STILL failing just re-arms its own retry, same as an
        // unattended attempt would.
        await updateRetriesFor(results, enabled);
        // A manual full sync just ran regardless of the per-marketplace
        // outcome above — push the unattended timer's next full pass a
        // period out from now (chrome.alarms.create with the same name
        // replaces the existing alarm and reschedules it from now). Any
        // marketplace still failing keeps catching up on its own faster
        // backoff instead; this only governs the OTHER, everything's-fine
        // case. Only touches the timer if auto-sync is actually on — a
        // manual click while it's stopped shouldn't quietly turn it back on.
        if (enabled) chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
      }
      await updateBadge();
      sendResponse(results);
    });
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
