const { getDb } = require('./db');

// Keeps the stored Myntra session "rolling" the way a real browser does.
//
// Verified live 2026-09-23: every successful partnersapi response carries
// Set-Cookie for `session` (a NEW value on every call — a rolling session),
// `erp.at` / `erp.rt` (the login tokens) and Akamai's `bm_sv`. A browser
// saves those automatically, which is why the seller's own tab stays logged
// in; the bot used to throw them away and keep replaying the exact cookies
// the extension captured, until that frozen copy aged out — "session
// expired" while the browser was still logged in. This merges whatever
// Myntra hands back into the stored session after each successful call.
//
// How Myntra's login actually works (verified live 2026-09-23): `erp.at` is
// the short-lived access token, `erp.rt` the refresh token. When erp.at is
// expired/invalid but erp.rt is good, Myntra silently REFRESHES — the call
// still succeeds and the reply carries a brand-new erp.at AND a new erp.rt.
// Only when both are bad does it answer statusCode 101 "Session expired".
// So saving these replies is what keeps the bot logged in; throwing them away
// is exactly why the bot's copy died each time erp.at aged out. A superseded
// erp.rt kept working after newer ones were issued, so the bot refreshing its
// own copy does not log the seller's browser out.
//
// Safety:
//  - Only after a SUCCESSFUL response (never a soft "session expired" one,
//    whose Set-Cookie would replace good cookies with logged-out ones).
//  - Only cookies the session already had, plus Myntra's known session
//    cookies — nothing unexpected gets added.
//  - Never deletes (a Max-Age=0 / past-Expires cookie is ignored).
//  - Compare-and-set on the exact cookie string that was sent: if the
//    extension (or a manual paste) saved a different session in the
//    meantime, the write simply doesn't match and nothing is overwritten.
//  - Never throws — a failed write just means the next call tries again.

const KNOWN_SESSION_COOKIES = new Set(['erp.at', 'erp.rt', 'session', 'bm_sv', 'ak_bmsc', 'NODE_HTTP_LOG']);

function parseCookieHeader(cookie) {
  const out = [];
  for (const part of String(cookie || '').split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    out.push([p.slice(0, eq).trim(), p.slice(eq + 1)]);
  }
  return out;
}

// One Set-Cookie header -> { name, value } or null if it's a deletion /
// expired / unparseable.
function parseSetCookie(line, now = Date.now()) {
  const [nameValue, ...attrs] = String(line || '').split(';');
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (!name || !value) return null;
  for (const raw of attrs) {
    const a = raw.trim();
    const lower = a.toLowerCase();
    if (lower.startsWith('max-age=')) {
      const n = Number(a.slice(8));
      if (Number.isFinite(n) && n <= 0) return null;
    } else if (lower.startsWith('expires=')) {
      const t = Date.parse(a.slice(8));
      if (Number.isFinite(t) && t <= now) return null;
    }
  }
  return { name, value };
}

/** Pure: the cookie header with any refreshed values applied. */
function mergeSetCookies(cookieHeader, setCookieLines, now = Date.now(), allowNew = KNOWN_SESSION_COOKIES) {
  const pairs = parseCookieHeader(cookieHeader);
  // A name can appear more than once (Chrome sends same-name cookies from
  // different paths/hosts); servers usually read the FIRST, so every copy is
  // refreshed — updating only the last one left a stale first copy in front.
  const index = new Map();
  pairs.forEach(([n], i) => index.set(n, [...(index.get(n) || []), i]));
  for (const line of setCookieLines || []) {
    const c = parseSetCookie(line, now);
    if (!c) continue;
    if (index.has(c.name)) {
      for (const i of index.get(c.name)) pairs[i][1] = c.value;
    } else if (allowNew && allowNew.has(c.name)) {
      index.set(c.name, [pairs.length]);
      pairs.push([c.name, c.value]);
    }
  }
  return pairs.map(([n, v]) => `${n}=${v}`).join('; ');
}

// Writing on EVERY call is wasteful (the SPF page alone makes ~140 calls in
// one go, and `session` changes on every one). Write at most once a minute
// per session per server instance — but always right away when a LOGIN token
// itself changes, since that's the one that matters. When a write is skipped
// the caller's in-memory headers are left untouched too, so the next call
// still matches the stored session and its refresh is saved then.
const PERSIST_EVERY_MS = 60 * 1000;
const lastPersistAt = new Map(); // sessionId -> ms

function tokensChanged(before, after, names) {
  const pick = (c) => Object.fromEntries(parseCookieHeader(c).filter(([n]) => names.includes(n)));
  const a = pick(before);
  const b = pick(after);
  return names.some((n) => a[n] !== b[n]);
}

const authChanged = (before, after) => tokensChanged(before, after, ['erp.at', 'erp.rt']);

function isSoftExpired(data) {
  const status = data && data.status;
  return !!(data && (data.sessionExpired || (status && (status.sessionExpired || status.statusCode === 101))));
}

/**
 * Generic: after a successful marketplace response, fold its Set-Cookie
 * refreshes into the stored session `sessionId` (compare-and-set on the exact
 * cookie string that was sent). `allowNew` = cookie names that may be added if
 * the session didn't have them yet; `authNames` = the login tokens whose change
 * is saved immediately (bypassing the once-a-minute limit).
 */
async function rollSessionCookies({ sessionId, sentHeaders, res, ok, allowNew, authNames }) {
  try {
    if (!res || res.status !== 200 || !ok) return;
    const setCookie = res.headers && res.headers['set-cookie'];
    const sent = sentHeaders && sentHeaders.cookie;
    if (!sent || !Array.isArray(setCookie) || !setCookie.length) return;
    const merged = mergeSetCookies(sent, setCookie, Date.now(), allowNew);
    if (merged === sent) return;
    const last = lastPersistAt.get(sessionId) || 0;
    if (Date.now() - last < PERSIST_EVERY_MS && !tokensChanged(sent, merged, authNames)) return;
    lastPersistAt.set(sessionId, Date.now());
    const db = await getDb();
    const r = await db.collection('settings').updateOne(
      { _id: sessionId, 'headers.cookie': sent },
      { $set: { 'headers.cookie': merged, cookiesRolledAt: new Date().toISOString() } },
    );
    // Keep the caller's in-memory copy in step with what's stored, so the
    // rest of the same run (e.g. paginated calls) sends the fresh values.
    // If nothing matched, a newer session was saved meanwhile — leave it be.
    if (r.matchedCount) sentHeaders.cookie = merged;
  } catch (err) {
    console.error(`${sessionId} cookie refresh not saved:`, err.message);
  }
}

/** Myntra: call after every partnersapi response. */
function persistRolledCookies(sentHeaders, res) {
  return rollSessionCookies({
    sessionId: 'session',
    sentHeaders,
    res,
    ok: res && !isSoftExpired(res.data),
    allowNew: KNOWN_SESSION_COOKIES,
    authNames: ['erp.at', 'erp.rt'],
  });
}

// Amazon Seller Central does the same thing (verified live 2026-09-23): a
// successful orders-api call re-issues `session-token` (a new value, 1-year
// cookie) via Set-Cookie. Only cookies the session already has are updated —
// nothing new is ever added for Amazon.
const AMAZON_AUTH_COOKIES = ['session-token', 'at-acbin', 'sess-at-acbin', 'x-acbin', 'sst-acbin'];

/** Amazon: call after every Seller Central response. Success = JSON body. */
function persistAmazonCookies(sentHeaders, res) {
  return rollSessionCookies({
    sessionId: 'session_amazon',
    sentHeaders,
    res,
    ok: !!(res && res.data && typeof res.data === 'object'),
    allowNew: new Set(),
    authNames: AMAZON_AUTH_COOKIES,
  });
}

module.exports = { mergeSetCookies, parseSetCookie, persistRolledCookies, persistAmazonCookies, isSoftExpired, authChanged };
