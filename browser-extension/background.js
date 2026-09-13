// Runs in the background (a Manifest V3 service worker) and, on a timer,
// reads the Myntra session cookies straight out of Chrome's cookie jar —
// including the HttpOnly ones a normal page script could never see — and
// sends them to the order-alert app's sync endpoint. This only ever reads
// cookies that already exist because you're logged into Myntra normally in
// this browser; it never logs in or touches your password.

const SYNC_ALARM = 'myntra-session-sync';
const SYNC_PERIOD_MINUTES = 120; // every 2 hours — the access token lives ~3h

async function getConfig() {
  const { appUrl, syncSecret } = await chrome.storage.local.get(['appUrl', 'syncSecret']);
  return { appUrl: (appUrl || '').replace(/\/+$/, ''), syncSecret: syncSecret || '' };
}

async function setLastResult(result) {
  await chrome.storage.local.set({ lastResult: { ...result, at: new Date().toISOString() } });
}

async function buildHeaders() {
  const cookies = await chrome.cookies.getAll({ domain: 'myntrainfo.com' });
  if (cookies.length === 0) {
    throw new Error('No Myntra cookies found — open mdirect.myntrainfo.com and log in first.');
  }
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  return {
    cookie: cookieHeader,
    accept: 'application/json, text/plain, */*',
    'x-myntra-app-name': 'mdirect',
    'x-myntra-client-id': 'mdirect',
    'x-myntra-mdirect-service': 'genie.orders.getOpenOrdersV2',
    'x-requested-with': 'XMLHttpRequest',
    'user-agent': navigator.userAgent,
  };
}

async function syncNow() {
  const { appUrl, syncSecret } = await getConfig();
  if (!appUrl || !syncSecret) {
    const result = { ok: false, error: 'Not configured yet — open the extension options.' };
    await setLastResult(result);
    return result;
  }

  try {
    const headers = await buildHeaders();
    const res = await fetch(`${appUrl}/api/session/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace: 'myntra', headers }),
    });
    const data = await res.json().catch(() => ({}));
    const result = res.ok
      ? { ok: true, headerCount: data.headerCount }
      : { ok: false, error: data.error || `HTTP ${res.status}` };
    await setLastResult(result);
    return result;
  } catch (err) {
    const result = { ok: false, error: err.message };
    await setLastResult(result);
    return result;
  }
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
