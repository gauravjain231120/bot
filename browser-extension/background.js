// Runs in the background (a Manifest V3 service worker) and, on a timer,
// reads the Myntra + Amazon session cookies straight out of Chrome's cookie
// jar — including the HttpOnly ones a normal page script could never see —
// and sends them to the order-alert app's sync endpoint. This only ever
// reads cookies that already exist because you're logged into these sites
// normally in this browser; it never logs in or touches a password.

const SYNC_ALARM = 'session-sync';
const SYNC_PERIOD_MINUTES = 120; // every 2 hours — Myntra's access token lives ~3h

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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncNow();
});

// Lets the popup trigger an immediate sync and read the result back.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === 'sync-now') {
    syncNow().then(sendResponse);
    return true; // keep the message channel open for the async response
  }
});
