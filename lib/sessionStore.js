const { getDb } = require('./db');
const { recordSessionCaptured } = require('./sessionHistory');
const { replyToChat } = require('./telegram');
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
async function saveSessionHeaders({ marketplace, headers: rawHeaders, source }) {
  const headers = cleanHeaders(rawHeaders);
  if (!headers.cookie) {
    throw new Error('No "cookie" header found.');
  }
  const isAmazon = marketplace === 'amazon';
  const sessionId = isAmazon ? 'session_amazon' : 'session';
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: sessionId },
    { $set: { headers, capturedAt: new Date().toISOString(), source: source || 'manual' } },
    { upsert: true }
  );
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
  await recordSessionCaptured(isAmazon ? 'amazon' : 'myntra');

  // Goes ONLY to the primary chat, not the broadcast list — this is a "you
  // just did something" confirmation, not order-alert-style news for everyone.
  await replyToChat(
    process.env.TELEGRAM_COMMAND_CHAT_ID,
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
 * Deliberately does NOT touch the expired-alert flag or session history the
 * way announceSessionActivated does — it's purely informational. That's what
 * keeps it safe from the alternating activated/expired spam loop a
 * flag-touching announcement caused before (see git history): a heartbeat
 * that never resets an alert flag can't feed that loop, no matter how often
 * it fires. Goes only to the primary chat (Gaurav), same as every other
 * session-management message, not the broadcast list.
 */
async function announceScheduledSyncOk(marketplace) {
  const label = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
  await replyToChat(
    process.env.TELEGRAM_COMMAND_CHAT_ID,
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

module.exports = { saveSession, saveSessionHeaders, announceSessionActivated, announceScheduledSyncOk };
