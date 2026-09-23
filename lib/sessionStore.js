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
async function saveSessionHeaders({ marketplace, headers: rawHeaders, source, syncPeriodMinutes }) {
  const headers = cleanHeaders(rawHeaders);
  if (!headers.cookie) {
    throw new Error('No "cookie" header found.');
  }
  const isAmazon = marketplace === 'amazon';
  const sessionId = isAmazon ? 'session_amazon' : 'session';
  const db = await getDb();
  const set = { headers, capturedAt: new Date().toISOString(), source: source || 'manual' };
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
async function announceSessionActivated(marketplace) {
  const isAmazon = marketplace === 'amazon';
  const expiredFlag = isAmazon ? 'amazonSessionExpiredAlertSent' : 'sessionExpiredAlertSent';
  const label = isAmazon ? 'Amazon' : 'Myntra';
  const db = await getDb();
  await db.collection('settings').updateOne({ _id: 'status' }, { $set: { [expiredFlag]: false } }, { upsert: true });

  // Goes ONLY to whoever has Owner role, not the broadcast list — this is a
  // "you just did something" confirmation, not order-alert-style news for everyone.
  await sendOwnerAlert(
    `✅ <b>${label} session activated</b>\n${formatIST(Date.now())}`,
    { silent: true }
  ).catch((err) => console.error('session-activated alert failed:', err.message));
}

/**
 * Quiet "still working" heartbeat for the extension's own 4-hour scheduled
 * sync — never for a backoff retry, which can repeat every 1-15 minutes
 * during an outage (see browser-extension/background.js: only the main
 * SYNC_ALARM firing passes `scheduled: true`, retries never do).
 *
 * Deliberately does NOT touch the expired-alert flag the way
 * announceSessionActivated does — it's purely informational. That's what
 * keeps it safe from the alternating activated/expired spam loop a
 * flag-touching announcement caused before (see git history): a heartbeat
 * that never resets an alert flag can't feed that loop, no matter how often
 * it fires. Goes only to whoever has Owner role, same as every other
 * session-management message, not the broadcast list.
 */
async function announceScheduledSyncOk(marketplace) {
  const label = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
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
  await announceSessionActivated(marketplace);
  return result;
}

/**
 * The extension noticed the bot's session had expired while the browser was
 * still logged in, synced, and the new session was verified working. Clears
 * the recorded error so the dashboard/health endpoint show it healthy right
 * away (the next check confirms it). Deliberately does NOT reset the
 * expired-alert flag — only a successful check does — so a flaky session
 * that keeps dying and being restored can't turn into an alert loop; and the
 * "restored" note is sent at most once per outage.
 */
async function markSessionRestored(marketplace) {
  const isAmazon = marketplace === 'amazon';
  const label = isAmazon ? 'Amazon' : 'Myntra';
  const errorField = isAmazon ? 'amazonLastError' : 'lastError';
  const noticeFlag = isAmazon ? 'amazonRestoreNoticeSent' : 'restoreNoticeSent';
  const db = await getDb();
  const settings = db.collection('settings');
  const status = (await settings.findOne({ _id: 'status' })) || {};
  await settings.updateOne({ _id: 'status' }, { $set: { [errorField]: '', [noticeFlag]: true } }, { upsert: true });
  if (!status[noticeFlag]) {
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

module.exports = { saveSession, saveSessionHeaders, announceSessionActivated, announceScheduledSyncOk, markSessionRestored, clearSessionError };
