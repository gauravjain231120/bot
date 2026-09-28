const { getDb } = require('./db');
const { sendOwnerAlert } = require('./telegram');
const { formatIST } = require('./dates');

// Headers that are transport-specific to one browser/request and make no sense
// replayed later from axios on a server — same list lib/curl.js drops.
const DROP_HEADERS = new Set(['content-length', 'accept-encoding', 'connection', 'host']);

function cleanHeaders(rawHeaders) {
  const headers = {};
  for (const [name, value] of Object.entries(rawHeaders || {})) {
    if (typeof value !== 'string') continue;
    const key = String(name).toLowerCase();
    if (DROP_HEADERS.has(key) || key.startsWith(':')) continue;
    headers[key] = value;
  }
  return headers;
}

/** Just stores the headers — no announcement, no alert-flag change. Callers
 *  decide separately (via announceSessionActivated) whether this is worth
 *  telling anyone about. */
async function saveSessionHeaders({ marketplace, headers: rawHeaders, source, syncPeriodMinutes, extensionVersion }) {
  const headers = cleanHeaders(rawHeaders);
  if (!headers.cookie) {
    throw new Error('No "cookie" header found.');
  }
  const isAmazon = marketplace === 'amazon';
  const sessionId = isAmazon ? 'session_amazon' : 'session';
  const db = await getDb();
  const nowIso = new Date().toISOString();
  const set = { headers, capturedAt: nowIso, lastSyncedAt: nowIso, source: source || 'manual' };
  // Which extension build sent it — shows whether an update was reloaded.
  if (extensionVersion) set.extensionVersion = String(extensionVersion).slice(0, 20);
  // How often the extension syncs this marketplace (set in its popup) — lets
  // the stale-sync watchdog use the real schedule instead of a fixed 4h. A
  // manual paste has no schedule, so any old value is cleared.
  const update = syncPeriodMinutes ? { $set: { ...set, syncPeriodMinutes } } : { $set: set, $unset: { syncPeriodMinutes: '' } };
  // A fresh session replaces the old one, cookie-refresh marker included.
  update.$unset = { ...(update.$unset || {}), cookiesRolledAt: '' };
  await db.collection('settings').updateOne({ _id: sessionId }, update, { upsert: true });
  return { headerCount: Object.keys(headers).length };
}

/**
 * Announces a session as activated: resets the expired-alert dedup flag (so
 * a still-broken session gets flagged again later) and sends a "you just did
 * something" Telegram confirmation. Only call this once the session is
 * actually known to work — see the extension sync route, which live-probes
 * a manually-triggered sync before calling this rather than assuming upload
 * success means it works.
 */
async function announceSessionActivated(marketplace, { alreadyActive = false, pasted = false } = {}) {
  const isAmazon = marketplace === 'amazon';
  const expiredFlag = isAmazon ? 'amazonSessionExpiredAlertSent' : 'sessionExpiredAlertSent';
  const label = isAmazon ? 'Amazon' : 'Myntra';
  const db = await getDb();
  const settings = db.collection('settings');
  const noticeFlag = isAmazon ? 'amazonRestoreNoticeSent' : 'restoreNoticeSent';
  const before = (await settings.findOne({ _id: 'status' }, { projection: { [expiredFlag]: 1, [noticeFlag]: 1 } })) || {};
  await settings.updateOne({ _id: 'status' }, { $set: { [expiredFlag]: false } }, { upsert: true });

  // Goes ONLY to whoever has Owner role, not the broadcast list — this is a
  // "you just did something" confirmation, not order-alert-style news for everyone.
  // Worded for what actually happened: it used to say "activated" whenever the
  // login tokens differed — for Myntra that's nearly always (its token renews
  // every few hours), which read as if the session had been broken.
  // "Restored" only for an expiry nobody has been told the end of yet (the
  // extension's own "restored automatically" note may already have said it).
  let text;
  if (before[expiredFlag] && !before[noticeFlag]) text = `✅ <b>${label} session restored</b> — checked now, it works again`;
  else if (pasted) text = `✅ <b>${label} session saved</b> — the pasted session is in use now`;
  else if (alreadyActive) text = `✅ <b>${label} session working</b> — checked now, same login as before`;
  else text = `✅ <b>${label} session working</b> — checked now; the bot saved this browser's latest login`;
  await sendOwnerAlert(`${text}\n${formatIST(Date.now())}`, { silent: true }).catch((err) =>
    console.error('session-activated alert failed:', err.message)
  );
}

/**
 * Quiet "still working" heartbeat for the extension's scheduled sync (and a
 * backoff retry of it) — at most about one per marketplace every 4 hours.
 *
 * Deliberately does NOT touch the expired-alert flag the way
 * announceSessionActivated does — it's purely informational. That's what
 * keeps it safe from the alternating activated/expired spam loop a
 * flag-touching announcement caused before (see git history): a heartbeat
 * that never resets an alert flag can't feed that loop, no matter how often
 * it fires. Goes only to whoever has Owner role, same as every other
 * session-management message, not the broadcast list.
 *
 * The minimum gap is 4h MINUS half the sync interval (interval capped at
 * 4h). It used to be a flat 4h — equal to the default 4h interval, so whether
 * a heartbeat went out came down to sub-second timing: on 2026-09-27 the 9:52
 * Amazon sync landed 0.54 s "too early" after the 5:52 heartbeat and was
 * silently skipped while Myntra's went through. Half an interval of slack
 * means every 4h sync sends one, and a 15-minute interval still gives one
 * every ~4h (not one per sync).
 */
const HEARTBEAT_EVERY_MS = 4 * 60 * 60 * 1000;

function heartbeatGapMs(periodMinutes) {
  const period = Math.min(HEARTBEAT_EVERY_MS, (Number(periodMinutes) || 240) * 60 * 1000);
  return HEARTBEAT_EVERY_MS - period / 2;
}

async function announceScheduledSyncOk(marketplace, periodMinutes) {
  const label = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
  const field = marketplace === 'amazon' ? 'amazonLastHeartbeatAt' : 'lastHeartbeatAt';
  const db = await getDb();
  const status = (await db.collection('settings').findOne({ _id: 'status' }, { projection: { [field]: 1 } })) || {};
  if (status[field] && Date.now() - new Date(status[field]).getTime() < heartbeatGapMs(periodMinutes)) return;
  await db.collection('settings').updateOne({ _id: 'status' }, { $set: { [field]: new Date().toISOString() } }, { upsert: true });
  await sendOwnerAlert(
    `🔄 ${label} auto-sync ok — ${formatIST(Date.now())}`,
    { silent: true }
  ).catch((err) => console.error('scheduled-sync heartbeat failed:', err.message));
}

/**
 * The admin "paste a session" form: storing AND announcing happen together,
 * unconditionally — a human just manually captured a curl command and
 * pasted it, which is inherently a deliberate "try this" action worth
 * announcing and worth re-arming the expired-alert for, the same way it
 * always has.
 */
async function saveSession({ marketplace, headers, source }) {
  const result = await saveSessionHeaders({ marketplace, headers, source });
  await announceSessionActivated(marketplace, { pasted: true });
  return result;
}

/**
 * The extension noticed the bot's session had expired while the browser was
 * still logged in, synced, and the new session was verified working. Clears
 * the recorded error so the dashboard/health endpoint show it healthy right
 * away (the next check confirms it). Deliberately does NOT reset the
 * expired-alert flag — only a successful check does — so a flaky session
 * that keeps dying and being restored can't turn into an alert loop.
 *
 * The "restored" note only follows an "expired" alert that actually went out
 * (at most once per outage). Restored within the alert's grace period
 * (lib/sessionAlerts.js) nobody was told it broke — so nothing to undo, no
 * message.
 */
async function markSessionRestored(marketplace) {
  const isAmazon = marketplace === 'amazon';
  const label = isAmazon ? 'Amazon' : 'Myntra';
  const errorField = isAmazon ? 'amazonLastError' : 'lastError';
  const noticeFlag = isAmazon ? 'amazonRestoreNoticeSent' : 'restoreNoticeSent';
  const expiredFlag = isAmazon ? 'amazonSessionExpiredAlertSent' : 'sessionExpiredAlertSent';
  const db = await getDb();
  const settings = db.collection('settings');
  const status = (await settings.findOne({ _id: 'status' })) || {};
  await settings.updateOne({ _id: 'status' }, { $set: { [errorField]: '', [noticeFlag]: true } }, { upsert: true });
  if (status[expiredFlag] && !status[noticeFlag]) {
    await sendOwnerAlert(
      `🔁 <b>${label} session restored automatically</b>
The browser was still logged in, so the extension re-synced it.
${formatIST(Date.now())}`,
      { silent: true }
    ).catch((err) => console.error('session-restored alert failed:', err.message));
  }
}

// A just-verified-working session shouldn't keep reading as "expired" (on the
// dashboard / health endpoint) until the next 5-minute check happens to run.
// Clears only the informational error text, never the alert flags.
async function clearSessionError(marketplace) {
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'status' },
    { $set: { [marketplace === 'amazon' ? 'amazonLastError' : 'lastError']: '' } },
    { upsert: true }
  );
}

// The login tokens that identify one login (same login = same tokens).
// Amazon: only the stable auth tokens — `session-token` changes on every call
// now that the bot keeps it refreshed, so it can't identify a login.
const LOGIN_COOKIES = { myntra: ['erp.at', 'erp.rt'], amazon: ['at-acbin', 'sess-at-acbin'] };

function loginTokens(marketplace, cookie) {
  const want = LOGIN_COOKIES[marketplace] || [];
  const found = {};
  for (const part of String(cookie || '').split(';')) {
    const p = part.trim();
    const eq = p.indexOf('=');
    if (eq > 0 && want.includes(p.slice(0, eq))) found[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return found;
}

/**
 * True if the stored session is working AND the incoming copy is the same
 * login (same tokens) — only used for the wording of a manual ↻ ("same login
 * as before" vs "activated"). Unattended syncs no longer skip on it (see
 * app/api/session/sync/route.js).
 */
async function isSameWorkingLogin(marketplace, incomingHeaders) {
  const db = await getDb();
  const settings = db.collection('settings');
  const [stored, status] = await Promise.all([
    settings.findOne({ _id: marketplace === 'amazon' ? 'session_amazon' : 'session' }, { projection: { headers: 1 } }),
    settings.findOne({ _id: 'status' }, { projection: { lastError: 1, amazonLastError: 1 } }),
  ]);
  if (!stored || !stored.headers) return false;
  if ((status || {})[marketplace === 'amazon' ? 'amazonLastError' : 'lastError']) return false;
  const a = loginTokens(marketplace, stored.headers.cookie);
  const b = loginTokens(marketplace, incomingHeaders && (incomingHeaders.cookie || incomingHeaders.Cookie));
  const names = LOGIN_COOKIES[marketplace];
  return names.some((n) => a[n]) && names.every((n) => a[n] === b[n]);
}

module.exports = { cleanHeaders, heartbeatGapMs, isSameWorkingLogin, saveSession, saveSessionHeaders, announceSessionActivated, announceScheduledSyncOk, markSessionRestored, clearSessionError };
