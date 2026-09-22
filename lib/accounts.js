const crypto = require('crypto');
const { getDb } = require('./db');

// Dashboard login accounts — replaces the old single shared ADMIN_PASSWORD
// with real per-person accounts and a role. `_id` is the lowercased username
// (already unique, no separate id needed). Two roles for now: OWNER (full
// access, including managing this Team list) and VIEWER (can log in and see
// the dashboard, nothing beyond that gated here yet — see PROJECT.md).
//
// `protected: true` marks the one seeded, founding Owner — refused by
// deleteAccount() and the "last Owner" check below, so there's no way to
// delete or lock out every Owner through this UI. Same pattern already used
// for the Telegram recipients list's founding Owner (lib/recipients.js).
const ROLES = ['OWNER', 'VIEWER'];
const SCRYPT_KEYLEN = 64;

// A fixed dummy salt so verifyPassword() pays the same scrypt cost whether or
// not the username exists — otherwise response time alone could reveal which
// usernames are real accounts (same timing side-channel stock-manager's own
// login already closes this way).
const DUMMY_SALT = 'dummy-salt-not-a-real-account-000000000000000000000000';

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

function normalizeUsername(username) {
  return (username || '').trim().toLowerCase();
}

async function accountsCollection() {
  const db = await getDb();
  return db.collection('accounts');
}

/** Owner-only account creation — used by both the Team UI and the one-off seed script. */
async function createAccount(username, password, role, { protectedAccount = false } = {}) {
  const id = normalizeUsername(username);
  if (!id) throw new Error('Username is required');
  if (!ROLES.includes(role)) throw new Error(`Invalid role: ${role}`);
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');

  const col = await accountsCollection();
  const existing = await col.findOne({ _id: id });
  if (existing) throw new Error(`"${id}" already exists`);

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  await col.insertOne({ _id: id, salt, passwordHash, role, protected: protectedAccount, createdAt: new Date() });
  return { username: id, role };
}

async function listAccounts() {
  const col = await accountsCollection();
  const docs = await col.find({}, { projection: { salt: 0, passwordHash: 0 } }).sort({ createdAt: 1 }).toArray();
  return docs.map((d) => ({ username: d._id, role: d.role, protected: Boolean(d.protected), createdAt: d.createdAt }));
}

/**
 * Verifies a login attempt. Always does exactly one scryptSync call, real
 * account or not — see DUMMY_SALT above for why. Returns {username, role} on
 * success, null on any failure (unknown username or wrong password — the
 * caller never needs to tell those apart).
 */
async function verifyPassword(username, password) {
  const id = normalizeUsername(username);
  const col = await accountsCollection();
  const account = await col.findOne({ _id: id });
  const hash = hashPassword(password || '', account ? account.salt : DUMMY_SALT);
  if (!account || hash !== account.passwordHash) return null;
  return { username: account._id, role: account.role };
}

/**
 * Removes an account from the Team list. Refuses the protected founding
 * Owner, and refuses removing the last remaining Owner outright (even an
 * unprotected one) so this UI can never lock every Owner out of it.
 */
async function deleteAccount(username) {
  const id = normalizeUsername(username);
  const col = await accountsCollection();
  const target = await col.findOne({ _id: id });
  if (!target) throw new Error('Account not found');
  if (target.protected) throw new Error('This account is protected and cannot be removed');
  if (target.role === 'OWNER') {
    const ownerCount = await col.countDocuments({ role: 'OWNER' });
    if (ownerCount <= 1) throw new Error('Cannot remove the last Owner account');
  }
  await col.deleteOne({ _id: id });
  const db = await getDb();
  await db.collection('sessions').deleteMany({ username: id });
}

module.exports = { ROLES, createAccount, listAccounts, verifyPassword, deleteAccount };
