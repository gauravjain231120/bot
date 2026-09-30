// Runs in the background (a Manifest V3 service worker) and, on a timer,
// reads the Myntra + Amazon session cookies straight out of Chrome's cookie
// jar — including the HttpOnly ones a normal page script could never see —
// and sends them to the order-alert app's sync endpoint. This only ever
// reads cookies that already exist because you're logged into these sites
// normally in this browser; it never logs in or touches a password.
//
// Four things run on their own:
//  1. A periodic sync PER MARKETPLACE ("session-sync-market-<name>"), each on
//     its own interval set in the popup (default 240 min = 4h).
//  2. Per-marketplace backoff retries when an unattended sync fails.
//  3. A 1-minute health check ("session-health") that asks the BOT — never
//     Myntra/Amazon — whether its session still works. If the bot's session
//     expired while this browser is still logged in, it re-syncs right away
//     instead of waiting hours for the next scheduled sync. If this browser
//     is logged out, it does NOT sync (a logged-out copy can't work) and
//     shows "log in" instead.
//  4. Amazon only: the moment this browser gets a NEW login (its login
//     cookies change), that login is synced to the bot straight away — the
//     bot's copy of the old login tends to stop working soon after, and
//     waiting up to 4h for the timer meant an "expired" alert first.

const SYNC_ALARM_PREFIX = 'session-sync-market-';
const LEGACY_SYNC_ALARM = 'session-sync'; // the old single shared alarm, migrated on startup
// One retry alarm PER marketplace (e.g. "session-sync-retry-amazon") so a
// broken Amazon session retries on its own schedule without also re-syncing
// a perfectly healthy Myntra session (and vice versa).
const RETRY_ALARM_PREFIX = 'session-sync-retry-';
const HEALTH_ALARM = 'session-health';
const HEALTH_PERIOD_MINUTES = 5;

const DEFAULT_PERIOD_MINUTES = 240; // 4 hours
const MIN_PERIOD_MINUTES = 15;
const MAX_PERIOD_MINUTES = 24 * 60;

// Backoff for retrying a failed *unattended* sync (e.g. the alarm fired while
// offline): 1m, 2m, 4m, 8m, then holds at 15m until it succeeds — instead of
// leaving the extension stuck waiting out the rest of the period.
const RETRY_DELAYS_MINUTES = [1, 2, 4, 8, 15];

// Recovery (health check saw the bot's session expired): at most one attempt
// per this many minutes, growing if the session keeps dying right after being
// restored — so a flaky session can never turn into a sync every minute.
const RECOVERY_BACKOFF_MINUTES = [5, 10, 20, 30];
// Don't "recover" a marketplace that was synced successfully this recently —
// the bot's next 5-minute check just hasn't confirmed it yet.

async function fetchWithRetry(url, maxTries = 2) {
  let lastErr;
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) return { _error: `HTTP ${res.status} Unauthorized (Check login)` };
      
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        if (text.toLowerCase().includes('sign in') || text.toLowerCase().includes('login')) {
           return { _error: 'Received a Sign-In page. Please log in to this marketplace in Chrome.' };
        }
        return { _error: 'Received HTML instead of JSON. Marketplace might be showing a Captcha/Bot page.' };
      }
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { _error: lastErr ? lastErr.message : 'Network error' };
}

function extractMyntraOrders(json) {
  const data = json && json.data;
  if (!Array.isArray(data)) return [];
  const orders = [];
  for (const item of data) {
    if (item && Array.isArray(item.fulfilmentOrderGroups)) {
      orders.push(...item.fulfilmentOrderGroups);
    } else if (item && item.orderId) {
      orders.push(item);
    }
  }
  return orders;
}

async function runProxyScraper(health, appUrl, syncSecret, localAmazon, localMyntra) {
  if (localAmazon && health.amazon && health.amazon.state !== 'missing') {
    const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
    const data = await fetchWithRetry(amzUrl);
    if (data && data._error) {
       console.error('Amazon local scrape failed:', data._error);
    } else if (data && Array.isArray(data.orders)) {
      await fetch(`${appUrl}/api/proxy-submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
        body: JSON.stringify({ marketplace: 'amazon', orders: data.orders })
      }).catch(console.error);
    }
  }

  if (localMyntra && health.myntra && health.myntra.state !== 'missing') {
    const warehouseId = health.warehouseId || '89623';
    const mynUrl = `https://partnersapi.myntrainfo.com/api/mdirect/orders/v2/open?status=CREATED&fetchSize=100&start=0&sortBy=id&sortOrder=ASC&warehouseId=${warehouseId}`;
    const data = await fetchWithRetry(mynUrl);
    if (data && !data._error) {
      const orders = extractMyntraOrders(data);
      if (orders && orders.length >= 0) { // even if 0, we push to let vercel know we checked
        await fetch(`${appUrl}/api/proxy-submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
          body: JSON.stringify({ marketplace: 'myntra', orders })
        }).catch(console.error);
      }
    } else {
      console.error('Myntra local scrape failed:', data ? data._error : 'Unknown error');
    }
  }
}

const RECENT_SYNC_GRACE_MS = 10 * 60 * 1000;
// A copy the bot rejected isn't re-sent for this long (unless you log in again
// and the cookies change) — never forever, in case the rejection was a fluke.
const BAD_COPY_HOLD_MS = 10 * 60 * 1000;
// New-login syncs (resyncOnNewLogin): at most one per marketplace every
// NEW_LOGIN_MIN_GAP_MS, however many cookie changes a login produces; if they
// keep failing for a reason that isn't the login (the bot or the marketplace
// briefly unreachable) the wait grows to an hour, and a login is tried at most
// NEW_LOGIN_MAX_TRIES times — the regular timer carries it after that.
const NEW_LOGIN_MIN_GAP_MS = 5 * 60 * 1000;
const NEW_LOGIN_BACKOFF_MIN = [5, 15, 30, 60];
const NEW_LOGIN_MAX_TRIES = 8;

const MARKETPLACES = [
  {
    marketplace: 'myntra',
    cookieDomain: 'myntrainfo.com',
    // Present only while logged in to M-Direct (the access token).
    loginCookies: ['erp.at'],
    // What identifies ONE login, for "is this a new login or the copy the bot
    // already rejected?". erp.rt only changes on a new login / token refresh.
    fingerprintCookies: ['erp.rt'],
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
    // Seller Central's auth cookies — either one means a live login. NOT
    // session-token: amazon.in's shopping site sets that for every visitor,
    // so it read as "logged in" after signing out of Seller Central (and, as
    // it changes on every page load, defeated the rejected-copy hold below).
    loginCookies: ['at-acbin', 'sess-at-acbin'],
    // Send exactly the cookies Chrome itself sends to the orders API the bot
    // calls — not every cookie of every amazon.in subdomain (the shopping
    // site's too), which gave duplicate names (a stored copy had csm-hit
    // twice) and a cookie header the real site never sees. Same order as
    // Chrome sends them.
    requestUrl: 'https://sellercentral.amazon.in/orders-api/search',
    // Stable per login — NOT session-token, which Amazon changes on almost
    // every page load (it would make every page look like a "new login").
    fingerprintCookies: ['at-acbin', 'sess-at-acbin'],
    // Hand a new login to the bot at once (see syncIfNewLogin). Not for
    // Myntra: its erp.rt changes on every token refresh, and the bot keeps
    // its own Myntra copy refreshed anyway.
    resyncOnNewLogin: true,
    staticHeaders: {
      accept: 'application/json, text/plain, */*',
      'x-requested-with': 'XMLHttpRequest',
      origin: 'https://sellercentral.amazon.in',
      referer: 'https://sellercentral.amazon.in/',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    // Amazon's own fraud/bot detection already 403s some requests on this
    // session (see lib/amazon.js's getWithRetry comment). A real browser tab
    // sends client hints and accept-language on every request; browserLike
    // fills those in from this actual browser at sync time.
    browserLike: true,
  },
];
const MARKETPLACE_NAMES = MARKETPLACES.map((m) => m.marketplace);
const EXT_VERSION = chrome.runtime.getManifest().version;

// chrome.storage has no transactions. Both marketplaces' timers fire at the
// same moment, and each sync used to read `lastResult`, merge its own row and
// write it back — the second write dropped the first one's result. Every
// read-modify-write of a shared key now queues behind the previous one.
const storageLocks = new Map();
function withStorageLock(key, fn) {
  const run = (storageLocks.get(key) || Promise.resolve()).then(fn, fn);
  storageLocks.set(key, run.catch(() => {}));
  return run;
}

// Merges `patch` (or patch(current)) into the object stored at `key`, reading
// the LATEST value at write time — never a copy read earlier.
function patchStore(key, patch) {
  return withStorageLock(key, async () => {
    const cur = (await chrome.storage.local.get([key]))[key] || {};
    const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
    await chrome.storage.local.set({ [key]: next });
    return next;
  });
}

// Chrome's User-Agent Client Hints, read fresh from this actual browser —
// mirrors the sec-ch-ua* headers a real tab sends alongside every fetch.
function chromeClientHints() {
  try {
    const uad = navigator.userAgentData;
    if (!uad) return {};
    const hints = { 'sec-ch-ua-mobile': uad.mobile ? '?1' : '?0' };
    if (Array.isArray(uad.brands) && uad.brands.length) {
      hints['sec-ch-ua'] = uad.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
    }
    if (uad.platform) hints['sec-ch-ua-platform'] = `"${uad.platform}"`;
    return hints;
  } catch {
    return {};
  }
}

const syncAlarmName = (marketplace) => `${SYNC_ALARM_PREFIX}${marketplace}`;
const retryAlarmName = (marketplace) => `${RETRY_ALARM_PREFIX}${marketplace}`;

async function getConfig() {
  const { appUrl, syncSecret } = await chrome.storage.local.get(['appUrl', 'syncSecret']);
  return { appUrl: (appUrl || '').replace(/\/+$/, ''), syncSecret: syncSecret || '' };
}

function clampPeriod(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_PERIOD_MINUTES;
  return Math.min(MAX_PERIOD_MINUTES, Math.max(MIN_PERIOD_MINUTES, n));
}

async function getPeriods() {
  const keys = MARKETPLACE_NAMES.map((m) => `syncPeriod_${m}`);
  const stored = await chrome.storage.local.get(keys);
  return Object.fromEntries(MARKETPLACE_NAMES.map((m) => [m, stored[`syncPeriod_${m}`] ? clampPeriod(stored[`syncPeriod_${m}`]) : DEFAULT_PERIOD_MINUTES]));
}

// Merges freshly-synced results into whatever's already stored rather than
// replacing the whole thing — a targeted sync only covers ONE marketplace,
// and must not blank out the other's last-known status. Each result carries
// its OWN `at`.
async function mergeLastResult(newResults) {
  return withStorageLock('lastResult', async () => {
    const { lastResult } = await chrome.storage.local.get(['lastResult']);
    const existing = (lastResult && lastResult.results) || [];
    const merged = newResults.length === 1 && newResults[0].marketplace === 'all'
      ? newResults
      : MARKETPLACE_NAMES.map(
          (name) => newResults.find((r) => r.marketplace === name) || existing.find((r) => r.marketplace === name)
        ).filter(Boolean);
    await chrome.storage.local.set({ lastResult: { results: merged } });
  });
}

async function buildHeaders({ cookieDomain, requestUrl, loginCookies, staticHeaders, browserLike }) {
  let cookies = [];
  if (requestUrl) {
    // chrome.cookies.getAll({url}) returns them in the browser's own send order.
    cookies = await chrome.cookies.getAll({ url: requestUrl });
    // Safety net: if the login cookies somehow aren't scoped to that URL,
    // fall back to the whole domain rather than send a copy without them.
    if (!cookies.some((c) => loginCookies.includes(c.name))) cookies = [];
  }
  if (cookies.length === 0) cookies = await chrome.cookies.getAll({ domain: cookieDomain });
  if (cookies.length === 0) {
    throw new Error(`No cookies found for ${cookieDomain} — log in there in this browser first.`);
  }
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const headers = { cookie: cookieHeader, 'user-agent': navigator.userAgent, ...staticHeaders };
  if (!browserLike) return headers;
  return {
    ...headers,
    'accept-language': (navigator.languages && navigator.languages.join(',')) || navigator.language || 'en-US,en;q=0.9',
    ...chromeClientHints(),
  };
}

// Is this browser logged in to the marketplace right now? (Its login cookie
// exists and hasn't expired.) Also returns a fingerprint of those cookies so a
// copy the bot already rejected is never re-sent until you log in again.
async function loginState(entry) {
  let cookies = await chrome.cookies.getAll({ domain: entry.cookieDomain });
  // Amazon's auth cookies (at-acbin, sess-at-acbin) may be scoped to
  // sellercentral.amazon.in and missed by a broad domain search on amazon.in.
  // Try the requestUrl too if the entry has one.
  if (entry.requestUrl) {
    const urlCookies = await chrome.cookies.getAll({ url: entry.requestUrl });
    const existingKeys = new Set(cookies.map((c) => `${c.domain}|${c.name}|${c.path}`));
    for (const c of urlCookies) {
      if (!existingKeys.has(`${c.domain}|${c.name}|${c.path}`)) cookies.push(c);
    }
  }
  const now = Date.now() / 1000;
  const live = cookies.filter(
    (c) => entry.loginCookies.includes(c.name) && c.value && (c.session || !c.expirationDate || c.expirationDate > now)
  );
  const names = entry.fingerprintCookies || entry.loginCookies;
  const idCookies = cookies.filter((c) => names.includes(c.name) && c.value);
  let hash = 5381;
  for (const c of (idCookies.length ? idCookies : live).sort((a, b) => a.name.localeCompare(b.name))) {
    const s = `${c.name}=${c.value};`;
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return { loggedIn: live.length > 0, fingerprint: live.length ? String(hash >>> 0) : null };
}

// `trigger` tells the server WHY this sync happened: 'manual' (a button click
// — worth a Telegram confirmation), 'auto' (the periodic timer, a backoff
// retry or a new login — silent), 'recovery' (the health check saw the bot's
// session die while this browser is still logged in). `scheduled` marks the
// periodic alarm and its retries, for the server's quiet ~4-hourly
// heartbeat (the server limits how often it's sent). The server TESTS the session before saving it and answers
// reason 'session-not-working' if it doesn't work (logged out / stale).
// The bot answers well within this (its own limit is 30s); without one, a
// hung request would sit until Chrome killed the service worker.
const SYNC_TIMEOUT_MS = 45000;

async function syncOne(entry, appUrl, syncSecret, trigger, scheduled, periodMinutes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);
  try {
    // Logged out in this browser: say so right here. Sending the copy would
    // only make the bot spend a Myntra/Amazon call testing a session that
    // can't work.
    const login = await loginState(entry);
    if (!login.loggedIn) {
      return {
        marketplace: entry.marketplace,
        ok: false,
        error: `Logged out — log in to ${entry.marketplace === 'amazon' ? 'Amazon Seller Central' : 'Myntra'} in this Chrome`,
        reason: 'logged-out',
        at: new Date().toISOString(),
        trigger,
      };
    }
    // An unattended sync never re-sends a copy the bot rejected recently (a
    // manual click still can — you may know something changed).
    if (trigger !== 'manual') {
      const key = `recovery_${entry.marketplace}`;
      const rec = (await chrome.storage.local.get([key]))[key] || {};
      if (login.fingerprint && login.fingerprint === rec.badFingerprint && rec.badAt && Date.now() - rec.badAt < BAD_COPY_HOLD_MS) {
        return {
          marketplace: entry.marketplace,
          ok: false,
          error: 'This login was just rejected by the bot — log in again in this Chrome',
          reason: 'session-not-working',
          at: new Date().toISOString(),
          trigger,
          skipped: true,
        };
      }
    }
    const headers = await buildHeaders(entry);
    const res = await fetch(`${appUrl}/api/session/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace: entry.marketplace, headers, trigger, scheduled: !!scheduled, periodMinutes, extVersion: EXT_VERSION }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    const at = new Date().toISOString();
    // `fingerprint`: the login actually sent — not whatever the cookies say
    // once the answer is back (a new login landing mid-sync would otherwise be
    // recorded as already synced, and never sent).
    return res.ok
      ? { marketplace: entry.marketplace, ok: true, headerCount: data.headerCount, at, trigger, fingerprint: login.fingerprint }
      : { marketplace: entry.marketplace, ok: false, error: data.error || `HTTP ${res.status}`, reason: data.reason || null, at, trigger, fingerprint: login.fingerprint };
  } catch (err) {
    const error = err && err.name === 'AbortError' ? "The bot didn't answer in time — will retry" : err.message;
    return { marketplace: entry.marketplace, ok: false, error, reason: null, at: new Date().toISOString(), trigger };
  } finally {
    clearTimeout(timer);
  }
}

// Marketplaces with a sync currently in flight. An unattended attempt never
// runs alongside another sync of the same marketplace (the health check, a
// timer and a new-login sync can all want one at the same moment) — it's
// simply left out, and callers treat "no result" as "someone else is on it".
// A manual click always runs.
const manualInFlight = new Set();
const autoInFlight = new Set();

// Syncs only the given marketplace names (defaults to all of them).
async function syncSome(names = MARKETPLACE_NAMES, trigger = 'auto', scheduled = false) {
  const { appUrl, syncSecret } = await getConfig();
  if (!appUrl || !syncSecret) {
    const results = [{ marketplace: 'all', ok: false, error: 'Not configured yet — open the extension options.', at: new Date().toISOString() }];
    await mergeLastResult(results);
    return results;
  }

  const periods = await getPeriods();
  let entries = MARKETPLACES.filter((m) => names.includes(m.marketplace));
  const inFlight = trigger === 'manual' ? manualInFlight : autoInFlight;
  if (trigger !== 'manual') {
    entries = entries.filter((m) => !manualInFlight.has(m.marketplace) && !autoInFlight.has(m.marketplace));
  }
  for (const m of entries) inFlight.add(m.marketplace);
  if (!entries.length) return [];

  try {
    const results = await Promise.all(
      entries.map((entry) => syncOne(entry, appUrl, syncSecret, trigger, scheduled, periods[entry.marketplace]))
    );
    await mergeLastResult(results);
    await noteLoginResults(results);
    return results;
  } finally {
    for (const m of entries) inFlight.delete(m.marketplace);
  }
}

// Remembers, per marketplace, whether the last sync showed this browser needs
// a real login — and the fingerprint of the copy the bot rejected, so the
// health check doesn't keep re-sending that same dead copy.
async function noteLoginResults(results) {
  for (const r of results) {
    if (!MARKETPLACE_NAMES.includes(r.marketplace)) continue;
    const entry = MARKETPLACES.find((m) => m.marketplace === r.marketplace);
    const key = `recovery_${r.marketplace}`;
    const sent = r.fingerprint !== undefined ? r.fingerprint : (await loginState(entry)).fingerprint;
    if (r.ok) {
      // The login the bot now has — syncIfNewLogin compares against it.
      await patchStore(key, { needsLogin: false, badFingerprint: null, syncedFingerprint: sent, newLoginTries: 0 });
    } else if (r.reason === 'logged-out') {
      await patchStore(key, { needsLogin: true });
    } else if (r.reason === 'session-not-working' && !r.skipped) {
      await patchStore(key, { needsLogin: true, badFingerprint: sent, badAt: Date.now() });
    }
  }
}

// Whether auto-sync (timers + health check) should be running — "Sync now"
// in the popup always works regardless of this.
async function isEnabled() {
  const { autoSyncEnabled } = await chrome.storage.local.get(['autoSyncEnabled']);
  return autoSyncEnabled !== false;
}

// Creates any missing alarm, WITHOUT resetting a countdown that's already
// running (re-creating on every startup would restart it from full every time
// Chrome opens). chrome.alarms keeps its real scheduled time across a browser
// restart on its own, and fires right after startup if it came due while
// Chrome was closed — so this never forces a sync itself.
async function ensureAlarms() {
  if (!(await isEnabled())) return;
  const periods = await getPeriods();
  const legacy = await chrome.alarms.get(LEGACY_SYNC_ALARM);
  for (const m of MARKETPLACE_NAMES) {
    const existing = await chrome.alarms.get(syncAlarmName(m));
    if (existing && existing.periodInMinutes === periods[m]) continue;
    // Keep the time already counted down: from the old shared alarm on first
    // run after updating, else from this marketplace's own alarm — never
    // later than one full new period from now.
    const carried = existing ? existing.scheduledTime : legacy ? legacy.scheduledTime : null;
    const fullPeriod = Date.now() + periods[m] * 60000;
    const when = carried && carried > Date.now() ? Math.min(carried, fullPeriod) : carried ? Date.now() + 60000 : fullPeriod;
    await chrome.alarms.create(syncAlarmName(m), { when, periodInMinutes: periods[m] });
  }
  if (legacy) await chrome.alarms.clear(LEGACY_SYNC_ALARM);
  const health = await chrome.alarms.get(HEALTH_ALARM);
  if (!health) await chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: HEALTH_PERIOD_MINUTES });
}

// Restart one marketplace's periodic timer a full period from now (after a
// successful manual sync, or when its interval is changed to something longer
// than what's left isn't wanted — see setPeriods).
async function resetSyncAlarm(marketplace) {
  if (!(await isEnabled())) return;
  const periods = await getPeriods();
  await chrome.alarms.create(syncAlarmName(marketplace), { delayInMinutes: periods[marketplace], periodInMinutes: periods[marketplace] });
}

async function getRetryCount(marketplace) {
  const key = `retryCount_${marketplace}`;
  const stored = await chrome.storage.local.get([key]);
  return stored[key] || 0;
}

// `scheduled`: the failed sync was the periodic one — only then does its
// retry count as scheduled (for the bot's ~4-hourly "auto-sync ok").
async function scheduleRetry(marketplace, scheduled = false) {
  const key = `retryCount_${marketplace}`;
  const count = await withStorageLock(key, async () => {
    const n = await getRetryCount(marketplace);
    const prev = (await chrome.storage.local.get([`retryScheduled_${marketplace}`]))[`retryScheduled_${marketplace}`];
    await chrome.storage.local.set({ [key]: n + 1, [`retryScheduled_${marketplace}`]: n > 0 ? !!prev || scheduled : scheduled });
    return n;
  });
  const delayInMinutes = RETRY_DELAYS_MINUTES[Math.min(count, RETRY_DELAYS_MINUTES.length - 1)];
  await chrome.alarms.create(retryAlarmName(marketplace), { delayInMinutes });
}

async function clearRetry(marketplace) {
  await chrome.alarms.clear(retryAlarmName(marketplace));
  await withStorageLock(`retryCount_${marketplace}`, () =>
    chrome.storage.local.set({ [`retryCount_${marketplace}`]: 0, [`retryScheduled_${marketplace}`]: false })
  );
}

async function pendingRetries() {
  const alarms = await chrome.alarms.getAll();
  return alarms.filter((a) => a.name.startsWith(RETRY_ALARM_PREFIX));
}

// Each marketplace that succeeded (or shouldn't retry) has its retry cleared;
// each still failing arms its own backoff — EXCEPT "session not working":
// that needs you to log in, and retrying the same copy every few minutes
// would just be pointless extra marketplace calls. The health check picks it
// up again as soon as you've logged in (new cookies).
async function updateRetriesFor(results, enabled, scheduled = false) {
  for (const r of results) {
    if (r.ok || !enabled || r.reason === 'session-not-working' || r.reason === 'logged-out') await clearRetry(r.marketplace);
    else await scheduleRetry(r.marketplace, scheduled);
  }
}

// Red "!" on the toolbar icon while any marketplace has a retry pending or
// needs you to log in, so a problem is visible without opening the popup.
async function updateBadge() {
  const pending = await pendingRetries();
  const recs = await chrome.storage.local.get(MARKETPLACE_NAMES.map((m) => `recovery_${m}`));
  const needsLogin = MARKETPLACE_NAMES.some((m) => recs[`recovery_${m}`] && recs[`recovery_${m}`].needsLogin);
  if (pending.length > 0 || needsLogin) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// A sync triggered by a timer (periodic alarm or backoff retry). On failure
// each marketplace arms its own short backoff retry.
async function runAutoSync(names = MARKETPLACE_NAMES, scheduled = false) {
  const results = await syncSome(names, 'auto', scheduled);
  const isUnconfigured = results.length === 1 && results[0].marketplace === 'all';
  if (isUnconfigured) {
    for (const name of names) await clearRetry(name);
    await updateBadge();
    return results;
  }
  await updateRetriesFor(results, await isEnabled(), scheduled);
  await updateBadge();
  return results;
}

// ---- Health check + auto-recovery ----

// A row is "waiting for you to log in" when this browser's last sync for it
// found it logged out, or the bot rejected its copy. As soon as a working
// login shows up here, sync it — no need to click ↻ or wait hours for the
// timer. Only then, so it's one small test per login, nothing more.
// Wait between attempts, saved in storage (survives the service worker
// sleeping): 1 min, then 5, 15, 30 if they keep failing for a reason that
// isn't the login (Myntra/Amazon briefly down, bot unreachable) — so an
// outage can't turn into a test call every minute. Reset on success.
const LOGIN_RESYNC_BACKOFF_MIN = [1, 5, 15, 30];

async function waitingForLogin(m) {
  const key = `recovery_${m}`;
  const store = await chrome.storage.local.get(['lastResult', key]);
  const rec = store[key] || {};
  const last = store.lastResult && (store.lastResult.results || []).find((r) => r.marketplace === m);
  const lastFailedOnLogin = last && !last.ok && (last.reason === 'logged-out' || last.reason === 'session-not-working');
  return { waiting: !!(rec.needsLogin || lastFailedOnLogin), rec };
}

// Returns true when it made an attempt (the new-login check then waits: one
// try per moment, not two back to back). At most LOGIN_RESYNC_MAX_TRIES per
// login — the regular timer carries it after that.
const LOGIN_RESYNC_MAX_TRIES = 8;
async function resyncAfterLogin(entry) {
  const m = entry.marketplace;
  if (!(await isEnabled())) return false;
  const now = Date.now();
  const { waiting, rec } = await waitingForLogin(m);
  if (!waiting) return false;
  const { loggedIn, fingerprint } = await loginState(entry);
  if (!loggedIn) return false;
  // Only a genuinely NEW login is tried here — never the copy the bot turned
  // down (no time limit on this one: that same login would just be refused
  // again, costing a Myntra/Amazon call each time).
  if (fingerprint && fingerprint === rec.badFingerprint) return false;
  // Tries are counted per login: a different one starts again.
  const tries = rec.resyncFingerprint === fingerprint ? rec.resyncCount || 0 : 0;
  if (tries >= LOGIN_RESYNC_MAX_TRIES) return false;
  // After the 1st failed try wait 1 min, after the 2nd 5 min, then 15, then 30.
  const wait = LOGIN_RESYNC_BACKOFF_MIN[Math.min(Math.max(tries - 1, 0), LOGIN_RESYNC_BACKOFF_MIN.length - 1)] * 60000;
  if (tries && rec.resyncAt && now - rec.resyncAt < wait) return false;
  const key = `recovery_${m}`;
  const [r] = await syncSome([m], 'auto');
  if (!r) return false; // another sync of this marketplace is already running
  if (r.ok) {
    // Its periodic timer is left alone, so both marketplaces' syncs (and their
    // "auto-sync ok") keep arriving together.
    await patchStore(key, { resyncAt: null, resyncCount: 0, resyncFingerprint: null, needsLogin: false });
    await clearRetry(m);
  } else {
    await patchStore(key, { resyncAt: now, resyncCount: tries + 1, resyncFingerprint: fingerprint });
  }
  await updateBadge();
  return true;
}

// This browser is logged in with a DIFFERENT login than the one the bot last
// accepted from it (resyncOnNewLogin marketplaces): sync it now, before the
// bot's copy of the old login stops working. Cheap when nothing changed —
// it only reads cookies. Never re-sends a copy the bot rejected; a try that
// failed is repeated only after NEW_LOGIN_BACKOFF_MIN (saved in storage, per
// login) and at most NEW_LOGIN_MAX_TRIES times — it used to be every 5 min for
// as long as the failure lasted, each one a marketplace test call, plus a
// separate retry timer. The 1-minute health check calls this too, so a wait
// that ends is picked up.
async function syncIfNewLogin(entry) {
  if (!entry.resyncOnNewLogin || !(await isEnabled())) return;
  const m = entry.marketplace;
  // Waiting for a login: resyncAfterLogin owns that (it syncs any new login,
  // with its own tries) — two paths taking turns doubled the test calls.
  if ((await waitingForLogin(m)).waiting) return;
  const key = `recovery_${m}`;
  const { loggedIn, fingerprint } = await loginState(entry);
  if (!loggedIn || !fingerprint) return;
  const rec = (await chrome.storage.local.get([key]))[key] || {};
  if (fingerprint === rec.syncedFingerprint || fingerprint === rec.badFingerprint) return;
  const tries = rec.newLoginFingerprint === fingerprint ? rec.newLoginTries || 0 : 0;
  if (tries >= NEW_LOGIN_MAX_TRIES) return;
  const wait = tries ? NEW_LOGIN_BACKOFF_MIN[Math.min(tries - 1, NEW_LOGIN_BACKOFF_MIN.length - 1)] * 60000 : NEW_LOGIN_MIN_GAP_MS;
  if (rec.newLoginSyncAt && Date.now() - rec.newLoginSyncAt < wait) return;
  if (autoInFlight.has(m) || manualInFlight.has(m)) return; // already syncing — it'll carry this login
  await patchStore(key, { newLoginSyncAt: Date.now(), newLoginFingerprint: fingerprint, newLoginTries: tries + 1 });
  const results = await syncSome([m], 'auto');
  if (!results.length || results[0].marketplace === 'all') return;
  // The periodic timer is left alone (moving it a full period on split the
  // two marketplaces' "auto-sync ok" apart).
  if (results[0].ok) await clearRetry(m);
  await updateBadge();
}

// Fires the moment a cookie changes in this browser. A few seconds after the
// last change (lets the rest of the login cookies land):
//  - a marketplace waiting for a login gets synced (resyncAfterLogin);
//  - a new login on a resyncOnNewLogin marketplace gets synced (syncIfNewLogin).
const loginTimers = new Map();
chrome.cookies.onChanged.addListener(({ removed, cookie }) => {
  if (removed || !cookie) return;
  const domain = String(cookie.domain || '').replace(/^\./, '');
  const entry = MARKETPLACES.find(
    (e) => domain.endsWith(e.cookieDomain) && (e.loginCookies.includes(cookie.name) || (e.resyncOnNewLogin && (e.fingerprintCookies || []).includes(cookie.name)))
  );
  if (!entry) return;
  clearTimeout(loginTimers.get(entry.marketplace));
  loginTimers.set(
    entry.marketplace,
    setTimeout(() => resyncAfterLogin(entry).then((tried) => (tried ? null : syncIfNewLogin(entry))), 5000)
  );
});

async function fetchHealth(appUrl, syncSecret) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${appUrl}/api/session/health`, { headers: { 'x-sync-secret': syncSecret, 'x-extension-version': EXT_VERSION }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let healthRunning = false;

async function checkHealth() {
  if (healthRunning) return;
  healthRunning = true;
  try {
    if (!(await isEnabled())) return;
    const { appUrl, syncSecret } = await getConfig();
    if (!appUrl || !syncSecret) return;

    let health;
    try {
      health = await fetchHealth(appUrl, syncSecret);
    } catch (err) {
      await chrome.storage.local.set({ health: { at: new Date().toISOString(), error: `Couldn't reach the bot: ${err.message}` } });
      return;
    }
    await chrome.storage.local.set({ health: { ...health, at: new Date().toISOString() } });

    try {
      const { localAmazon, localMyntra } = await chrome.storage.local.get(['localAmazon', 'localMyntra']);
      if (localAmazon || localMyntra) {
        await runProxyScraper(health, appUrl, syncSecret, localAmazon, localMyntra);
      }
    } catch (err) {
      console.error('Proxy scraper failed:', err);
    }

    const { lastResult } = await chrome.storage.local.get(['lastResult']);
    for (const entry of MARKETPLACES) {
      const m = entry.marketplace;
      const state = health[m] && health[m].state;
      const key = `recovery_${m}`;
      const rec = (await chrome.storage.local.get([key]))[key] || {};

      if (state === 'ok') {
        if (rec.count || rec.needsLogin) await patchStore(key, { count: 0, needsLogin: false });
        // Bot is fine, but this browser's row may be waiting for a login, or
        // hold a newer login than the bot's — sync it now if so (backup for
        // the cookie event, which a sleeping worker can miss).
        if (!(await resyncAfterLogin(entry))) await syncIfNewLogin(entry);
        continue;
      }
      if (state !== 'expired' && state !== 'missing') continue; // network/5xx: a re-sync won't help
      if (health.running === false) continue; // bot's checks are stopped — nothing would confirm it

      const now = Date.now();
      const wait = RECOVERY_BACKOFF_MINUTES[Math.min(rec.count || 0, RECOVERY_BACKOFF_MINUTES.length - 1)] * 60000;
      if (rec.lastAt && now - rec.lastAt < wait) continue;
      const last = lastResult && (lastResult.results || []).find((r) => r.marketplace === m);
      if (last && last.ok && now - new Date(last.at).getTime() < RECENT_SYNC_GRACE_MS) continue;

      const { loggedIn, fingerprint } = await loginState(entry);
      if (!loggedIn) {
        // Logged out in this browser — syncing would just send a dead copy.
        if (!rec.needsLogin) await patchStore(key, { needsLogin: true });
        continue;
      }
      // Same copy the bot rejected recently — wait for a fresh login (new cookies) or the hold to pass.
      if (fingerprint && fingerprint === rec.badFingerprint && rec.badAt && now - rec.badAt < BAD_COPY_HOLD_MS) continue;

      const [r] = await syncSome([m], 'recovery');
      if (!r) continue; // another sync of this marketplace is already running
      await patchStore(key, { lastAt: now, count: (rec.count || 0) + 1, ...(r.ok ? { needsLogin: false } : {}) });
      if (r.ok) await clearRetry(m);
    }
  } finally {
    healthRunning = false;
    await updateBadge();
  }
}

// ---- Start / stop / intervals ----

async function startAutoSync() {
  await chrome.storage.local.set({ autoSyncEnabled: true });
  const periods = await getPeriods();
  for (const m of MARKETPLACE_NAMES) {
    await chrome.alarms.create(syncAlarmName(m), { delayInMinutes: periods[m], periodInMinutes: periods[m] });
  }
  await chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: HEALTH_PERIOD_MINUTES });
  return runAutoSync();
}

async function stopAutoSync() {
  await chrome.storage.local.set({ autoSyncEnabled: false });
  for (const m of MARKETPLACE_NAMES) {
    await chrome.alarms.clear(syncAlarmName(m));
    await clearRetry(m);
  }
  await chrome.alarms.clear(LEGACY_SYNC_ALARM);
  await chrome.alarms.clear(HEALTH_ALARM);
  await updateBadge();
}

// New intervals from the popup. A shorter interval takes effect now (the
// next sync moves earlier if it was further away than the new period); a
// longer one keeps the current countdown and applies from the next cycle.
async function setPeriods(input) {
  const current = await getPeriods();
  const next = {};
  for (const m of MARKETPLACE_NAMES) next[m] = input && input[m] != null ? clampPeriod(input[m]) : current[m];
  await chrome.storage.local.set(Object.fromEntries(MARKETPLACE_NAMES.map((m) => [`syncPeriod_${m}`, next[m]])));
  if (await isEnabled()) {
    for (const m of MARKETPLACE_NAMES) {
      if (next[m] === current[m]) continue;
      const existing = await chrome.alarms.get(syncAlarmName(m));
      const fullPeriod = Date.now() + next[m] * 60000;
      const when = existing ? Math.min(existing.scheduledTime, fullPeriod) : fullPeriod;
      await chrome.alarms.create(syncAlarmName(m), { when, periodInMinutes: next[m] });
    }
  }
  return next;
}

// ---- Events ----

// Fresh install / update: make sure alarms exist (carrying over any running
// countdown), and on a brand-new install sync right away.
chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarms().then(updateBadge);
  if (details && details.reason === 'install') isEnabled().then((on) => on && runAutoSync());
});
// Browser restart: only make sure the alarms still exist — never force a sync.
chrome.runtime.onStartup.addListener(() => {
  ensureAlarms().then(updateBadge);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEALTH_ALARM) {
    checkHealth();
  } else if (alarm.name.startsWith(RETRY_ALARM_PREFIX)) {
    // A retry of the scheduled sync finishes it — `scheduled` lets its success
    // send the ~4-hourly heartbeat (the bot limits how often). A retry of a
    // manual click isn't a scheduled sync.
    const m = alarm.name.slice(RETRY_ALARM_PREFIX.length);
    chrome.storage.local.get([`retryScheduled_${m}`]).then((s) => runAutoSync([m], !!s[`retryScheduled_${m}`]));
  } else if (alarm.name.startsWith(SYNC_ALARM_PREFIX)) {
    runAutoSync([alarm.name.slice(SYNC_ALARM_PREFIX.length)], true);
  } else if (alarm.name === LEGACY_SYNC_ALARM) {
    // Fired before the migration ran — sync both, then move to per-marketplace alarms.
    runAutoSync(MARKETPLACE_NAMES, true).then(ensureAlarms);
  }
});

// Connectivity back while a retry is pending: jump the queue for just those
// (a retry of the scheduled sync stays scheduled — its heartbeat included).
self.addEventListener('online', () => {
  pendingRetries().then(async (alarms) => {
    for (const a of alarms) {
      const m = a.name.slice(RETRY_ALARM_PREFIX.length);
      const s = await chrome.storage.local.get([`retryScheduled_${m}`]);
      runAutoSync([m], !!s[`retryScheduled_${m}`]);
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const isFullSync = message === 'sync-now';
  const targetMarketplace = message && typeof message === 'object' && message.type === 'sync-now' ? message.marketplace : null;
  if (isFullSync || targetMarketplace) {
    const names = targetMarketplace ? [targetMarketplace] : MARKETPLACE_NAMES;
    syncSome(names, 'manual').then(async (results) => {
      const isUnconfigured = results.length === 1 && results[0].marketplace === 'all';
      if (!isUnconfigured) {
        const enabled = await isEnabled();
        await updateRetriesFor(results, enabled);
        // A marketplace that just synced fine starts a fresh period from now.
        for (const r of results) if (r.ok) await resetSyncAlarm(r.marketplace);
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
  if (message === 'get-periods') {
    getPeriods().then((periods) => sendResponse({ periods, min: MIN_PERIOD_MINUTES, max: MAX_PERIOD_MINUTES, def: DEFAULT_PERIOD_MINUTES }));
    return true;
  }
  if (message && typeof message === 'object' && message.type === 'set-periods') {
    setPeriods(message.periods).then((periods) => sendResponse({ ok: true, periods }));
    return true;
  }
  if (message === 'check-health-now') {
    checkHealth().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// A worker started by any event (e.g. after an extension update/reload)
// makes sure its alarms exist.
ensureAlarms();


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'test-local') {
    handleTestLocal(msg.marketplace).then(sendResponse);
    return true;
  }
  if (msg.type === 'test-cloud') {
    handleTestCloud(msg.marketplace).then(sendResponse);
    return true;
  }
});

async function handleTestLocal(marketplace) {
  try {
    const { appUrl, syncSecret } = await getConfig();
    let orders = [];
    
    if (marketplace === 'amazon') {
      const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
      const data = await fetchWithRetry(amzUrl);
      if (data && data._error) return { ok: false, error: data._error };
      if (data && Array.isArray(data.orders)) orders = data.orders;
      else return { ok: false, error: 'Could not parse Amazon orders array' };
    } else {
      const healthObj = (await chrome.storage.local.get(['health'])).health || {};
      const warehouseId = healthObj.warehouseId || '89623';
      const mynUrl = `https://partnersapi.myntrainfo.com/api/mdirect/orders/v2/open?status=CREATED&fetchSize=100&start=0&sortBy=id&sortOrder=ASC&warehouseId=${warehouseId}`;
      const data = await fetchWithRetry(mynUrl);
      if (data && data._error) return { ok: false, error: data._error };
      orders = extractMyntraOrders(data);
      if (!orders) return { ok: false, error: 'Could not extract Myntra orders' };
    }

    const res = await fetch(`${appUrl}/api/proxy-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace, type: 'local', orders })
    });
    
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch(e) {
      return { ok: false, error: 'Vercel server error (Deployment might be building)' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleTestCloud(marketplace) {
  try {
    const { appUrl, syncSecret } = await getConfig();
    const res = await fetch(`${appUrl}/api/proxy-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace, type: 'cloud' })
    });
    
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch(e) {
      return { ok: false, error: 'Vercel server error (Deployment might be building)' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
