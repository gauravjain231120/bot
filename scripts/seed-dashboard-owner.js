/**
 * One-off: seed the founding dashboard-login Owner account, replacing the
 * old single shared ADMIN_PASSWORD with real per-person accounts + roles.
 * Marked `protected` so it can never be deleted through the Team UI —
 * same safeguard already used for the Telegram recipients list's founding
 * Owner (see protect-primary-owner.js).
 *
 * Run once, right after deploying the accounts feature:
 *   node scripts/seed-dashboard-owner.js
 */
const fs = require('fs');
const path = require('path');

function loadEnvLocal() {
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const crypto = require('crypto');
const { getDb } = require('../lib/db');

const USERNAME = 'gaurav';
const PASSWORD = 'Gaurav@23112001';
const ROLE = 'OWNER';

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function main() {
  const db = await getDb();
  const col = db.collection('accounts');

  const existing = await col.findOne({ _id: USERNAME });
  if (existing) {
    console.log(`"${USERNAME}" already exists (role=${existing.role}) — left untouched.`);
    process.exit(0);
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(PASSWORD, salt);
  await col.insertOne({
    _id: USERNAME,
    salt,
    passwordHash,
    role: ROLE,
    protected: true,
    createdAt: new Date(),
  });
  console.log(`Created "${USERNAME}" as ${ROLE} (protected).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
