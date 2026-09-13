// Runs in the background (a Manifest V3 service worker) and, on a timer,
// reads the Myntra + Amazon session cookies straight out of Chrome's cookie
// jar — including the HttpOnly ones a normal page script could never see —
// and sends them to the order-alert app's sync endpoint. This only ever
// reads cookies that already exist because you're logged into these sites
// normally in this browser; it never logs in or touches a password.

const SYNC_ALARM = 'session-sync';
const SYNC_PERIOD_MINUTES = 240; // every 4 hours

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
// countdown back to full every time Chrome (re)opens — meaning if the session
// died while the browser was closed, reopening it wouldn't fix anything until
// a full period passed again. Only create it if it doesn't already exist (or
// its period changed in code), and separately fire an immediate sync on every
// startup so reopening Chrome always catches up right away instead of waiting.
async function ensureAlarm() {
  if (!(await isEnabled())) return;
  const existing = await chrome.alarms.get(SYNC_ALARM);
  if (!existing || existing.periodInMinutes !== SYNC_PERIOD_MINUTES) {
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
  }
}

async function startAutoSync() {
  await chrome.storage.local.set({ autoSyncEnabled: true });
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
  return syncNow();
}

async function stopAutoSync() {
  await chrome.storage.local.set({ autoSyncEnabled: false });
  await chrome.alarms.clear(SYNC_ALARM);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  isEnabled().then((on) => on && syncNow());
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  isEnabled().then((on) => on && syncNow());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncNow();
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
