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
async function saveSession({ marketplace, headers: rawHeaders, source }) {
  const headers = cleanHeaders(rawHeaders);
  if (!headers.cookie) {
    throw new Error('No "cookie" header found.');
  }

  const isAmazon = marketplace === 'amazon';
  const sessionId = isAmazon ? 'session_amazon' : 'session';
  const expiredFlag = isAmazon ? 'amazonSessionExpiredAlertSent' : 'sessionExpiredAlertSent';
  const label = isAmazon ? 'Amazon' : 'Myntra';

  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: sessionId },
    { $set: { headers, capturedAt: new Date().toISOString(), source: source || 'manual' } },
    { upsert: true }
  );
  await db.collection('settings').updateOne({ _id: 'status' }, { $set: { [expiredFlag]: false } }, { upsert: true });
  await recordSessionCaptured(isAmazon ? 'amazon' : 'myntra');

  // Goes ONLY to the primary chat, not the broadcast list — this is a "you
  // just did something" confirmation, not order-alert-style news for everyone.
  // Silent on purpose: this fires every couple of hours once the extension is
  // syncing, and it's a routine all-clear, not something that needs a buzz —
  // unlike session-EXPIRED, which stays noisy since that one needs attention.
  const via = source === 'extension' ? ' (extension)' : '';
  await replyToChat(
    process.env.TELEGRAM_COMMAND_CHAT_ID,
    `✅ <b>${label} session activated</b>${via}\n${formatIST(Date.now())}`,
    { silent: true }
  ).catch((err) => console.error('session-activated alert failed:', err.message));

  return { headerCount: Object.keys(headers).length };
}

module.exports = { saveSession };
