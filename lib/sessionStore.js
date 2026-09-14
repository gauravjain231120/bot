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

// Shared by the admin "paste a session" form and the browser extension sync —
// both end up with the same { headers } shape, just captured differently.
async function saveSession({ marketplace, headers: rawHeaders, source, trigger }) {
  const headers = cleanHeaders(rawHeaders);
  if (!headers.cookie) {
    throw new Error('No "cookie" header found.');
  }

  const isAmazon = marketplace === 'amazon';
  const sessionId = isAmazon ? 'session_amazon' : 'session';
  const expiredFlag = isAmazon ? 'amazonSessionExpiredAlertSent' : 'sessionExpiredAlertSent';
  const label = isAmazon ? 'Amazon' : 'Myntra';

  const db = await getDb();
  const settings = db.collection('settings');

  await settings.updateOne(
    { _id: sessionId },
    { $set: { headers, capturedAt: new Date().toISOString(), source: source || 'manual' } },
    { upsert: true }
  );

  // Worth announcing and worth re-arming the expired-alert (so a still-
  // broken session gets flagged again) for two cases: a MANUAL paste on the
  // admin page, or an extension sync a human explicitly triggered by
  // clicking Sync in the popup (trigger: 'manual') — both are a person
  // deliberately asking "does this work now?" and deserve an answer either
  // way. What must NOT trigger this is the extension's UNATTENDED syncs —
  // the periodic timer or a backoff retry, happening on their own as often
  // as once a minute while retrying, with whatever's currently in the cookie
  // jar and no way to know whether anything actually changed. Comparing
  // cookie values to detect "a real new session" doesn't work either —
  // Amazon refreshes some of its own session-tracking cookies in the
  // background regardless of login state, so that comparison kept looking
  // "new" every unattended retry even while genuinely logged out, still
  // resetting the dedup flag and letting the very next failed poll re-fire
  // "session expired" every few minutes.
  if (source !== 'extension' || trigger === 'manual') {
    await settings.updateOne({ _id: 'status' }, { $set: { [expiredFlag]: false } }, { upsert: true });
    await recordSessionCaptured(isAmazon ? 'amazon' : 'myntra');

    // Goes ONLY to the primary chat, not the broadcast list — this is a "you
    // just did something" confirmation, not order-alert-style news for
    // everyone.
    await replyToChat(
      process.env.TELEGRAM_COMMAND_CHAT_ID,
      `✅ <b>${label} session activated</b>\n${formatIST(Date.now())}`,
      { silent: true }
    ).catch((err) => console.error('session-activated alert failed:', err.message));
  }

  return { headerCount: Object.keys(headers).length };
}

module.exports = { saveSession };
