/**
 * One-off: mark the seeded founding-Owner row (Gaurav) as `protected: true`
 * so it's hidden from the dashboard's Recipients list and refused by
 * setRole/deleteRecipient — no way to demote or remove yourself through
 * that UI and lock everyone out. Promoting OTHER people to Owner from the
 * visible list is unaffected.
 *
 *   node scripts/protect-primary-owner.js --dry
 *   node scripts/protect-primary-owner.js
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

const { getDb } = require('../lib/db');

const DRY = process.argv.includes('--dry');
const PRIMARY_OWNER_CHAT_ID = '5349388385'; // Gaurav — from PROJECT.md §4 / scripts/seed-recipients.js

async function main() {
  console.log(DRY ? '=== DRY RUN — nothing will be written ===\n' : '=== APPLYING ===\n');

  const db = await getDb();
  const col = db.collection('recipients');
  const doc = await col.findOne({ _id: PRIMARY_OWNER_CHAT_ID });

  if (!doc) {
    console.log(`No recipient row for ${PRIMARY_OWNER_CHAT_ID} — run scripts/seed-recipients.js first.`);
    process.exit(1);
  }
  if (doc.protected) {
    console.log(`${PRIMARY_OWNER_CHAT_ID} (${doc.name}) is already protected — nothing to do.`);
    process.exit(0);
  }

  console.log(`${PRIMARY_OWNER_CHAT_ID} (${doc.name}, role=${doc.role}) -> protected: true`);
  if (!DRY) {
    await col.updateOne({ _id: PRIMARY_OWNER_CHAT_ID }, { $set: { protected: true } });
    console.log('\nDone.');
  } else {
    console.log('\nDRY RUN — nothing was written.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
