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
function mergeSetCookies(cookieHeader, setCookieLines, now = Date.now()) {
  const pairs = parseCookieHeader(cookieHeader);
  const index = new Map(pairs.map(([n], i) => [n, i]));
  for (const line of setCookieLines || []) {
    const c = parseSetCookie(line, now);
    if (!c) continue;
    if (index.has(c.name)) {
      pairs[index.get(c.name)][1] = c.value;
    } else if (KNOWN_SESSION_COOKIES.has(c.name)) {
      index.set(c.name, pairs.length);
      pairs.push([c.name, c.value]);
    }
  }
  return pairs.map(([n, v]) => `${n}=${v}`).join('; ');
}

function isSoftExpired(data) {
  const status = data && data.status;
  return !!(data && (data.sessionExpired || (status && (status.sessionExpired || status.statusCode === 101))));
}

/**
 * Call after a Myntra response. `sentHeaders` is the headers object the
 * request was made with (the stored session's, normally).
 */
async function persistRolledCookies(sentHeaders, res) {
  try {
    if (!res || res.status !== 200 || isSoftExpired(res.data)) return;
    const setCookie = res.headers && res.headers['set-cookie'];
    const sent = sentHeaders && sentHeaders.cookie;
    if (!sent || !Array.isArray(setCookie) || !setCookie.length) return;
    const merged = mergeSetCookies(sent, setCookie);
    if (merged === sent) return;
    const db = await getDb();
    await db.collection('settings').updateOne(
      { _id: 'session', 'headers.cookie': sent },
      { $set: { 'headers.cookie': merged, cookiesRolledAt: new Date().toISOString() } },
    );
    // Keep the caller's in-memory copy current too, so the rest of the same
    // run (e.g. paginated calls) sends the fresh values.
    sentHeaders.cookie = merged;
  } catch (err) {
    console.error('Myntra cookie refresh not saved:', err.message);
  }
}

module.exports = { mergeSetCookies, parseSetCookie, persistRolledCookies, isSoftExpired };
