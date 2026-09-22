const crypto = require('crypto');
const { cookies } = require('next/headers');
const { getDb } = require('./db');

// Session-token cookie (same name/shape the old single-shared-password cookie
// used — httpOnly, 30 days) but the value is now a random session token tied
// to a real account row, not the raw password itself. Every isAuthed() call
// site across the app is unchanged by this — it only ever cared about the
// boolean.
const COOKIE_NAME = 'admin_auth';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function sessionsCollection() {
  const db = await getDb();
  return db.collection('sessions');
}

async function createSession(username, role) {
  const col = await sessionsCollection();
  const token = crypto.randomBytes(32).toString('hex');
  await col.insertOne({
    _id: token,
    username,
    role,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

async function destroySession(token) {
  if (!token) return;
  const col = await sessionsCollection();
  await col.deleteOne({ _id: token });
}

/** {username, role} for the logged-in account, or null — reads the cookie, no caching. */
async function getCurrentAccount() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const col = await sessionsCollection();
  const session = await col.findOne({ _id: token });
  if (!session || session.expiresAt.getTime() < Date.now()) return null;
  return { username: session.username, role: session.role };
}

async function isAuthed() {
  return Boolean(await getCurrentAccount());
}

/**
 * Shared Owner-only guard for API routes — anything that manages who has
 * dashboard access (accounts) or who gets Telegram-alerted (recipients) is
 * Owner-only, not just hidden in the UI. Callers do:
 *   const check = await requireOwner();
 *   if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
 * Kept as a plain object (not a NextResponse) so this stays a logic-only lib
 * file — route handlers own constructing the actual HTTP response.
 */
async function requireOwner() {
  const account = await getCurrentAccount();
  if (!account) return { ok: false, status: 401, error: 'unauthorized' };
  if (account.role !== 'OWNER') return { ok: false, status: 403, error: 'Owner only' };
  return { ok: true, account };
}

module.exports = { isAuthed, getCurrentAccount, requireOwner, createSession, destroySession, COOKIE_NAME, SESSION_TTL_MS };
