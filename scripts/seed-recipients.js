/**
 * One-off: seed the new `recipients` collection (role-based Telegram alert
 * routing, replacing the old TELEGRAM_CHAT_ID / TELEGRAM_COMMAND_CHAT_ID
 * env-var lists) with the 3 people already receiving alerts today, at the
 * role they already effectively have — so alert delivery doesn't go dark
 * the moment this deploys, before anyone re-messages the bot.
 *
 * Run once, right after deploying the recipients feature:
 *   node scripts/seed-recipients.js --dry
 *   node scripts/seed-recipients.js
 */
const fs = require('fs');
const path = require('path');

// No dotenv dependency in this project — .env.local is a flat KEY=value
// file, so a tiny manual loader is enough (mirrors what Next.js's own
// built-in env loading does for local dev).
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

// From PROJECT.md §4's "Telegram recipients" table.
const SEED = [
  { chatId: '5349388385', name: 'Gaurav', role: 'OWNER' },
  { chatId: '8811057878', name: 'Mukesh Bhandari', role: 'VIEWER' },
  { chatId: '8850201003', name: 'Alka Bhandari', role: 'VIEWER' },
];

async function main() {
  console.log(DRY ? '=== DRY RUN — nothing will be written ===\n' : '=== APPLYING ===\n');

  const db = await getDb();
  const col = db.collection('recipients');

  for (const { chatId, name, role } of SEED) {
    const existing = await col.findOne({ _id: chatId });
    if (existing) {
      console.log(`  ${chatId.padEnd(14)} ${name.padEnd(18)} already exists (role=${existing.role}) — left untouched`);
      continue;
    }
    console.log(`  ${chatId.padEnd(14)} ${name.padEnd(18)} -> role=${role} (new)`);
    if (DRY) continue;

    const now = new Date();
    await col.updateOne(
      { _id: chatId },
      { $set: { chatId, name, username: null, role, firstSeenAt: now, lastSeenAt: now } },
      { upsert: true },
    );
  }

  if (DRY) console.log('\nDRY RUN — nothing was written.');
  else console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
