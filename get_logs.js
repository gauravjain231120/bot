const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf8');
env.split('\n').forEach(line => {
  if (line.trim() && !line.startsWith('#')) {
    const [k, ...v] = line.split('=');
    process.env[k.trim()] = v.join('=').trim();
  }
});
const { getDb } = require('./lib/db');

async function main() {
  const db = await getDb();
  
  const status = await db.collection('settings').findOne({ _id: 'status' });
  console.log('=== STATUS ===');
  console.log('amazonLastError:', status?.amazonLastError);
  console.log('amazonLastCheck:', status?.amazonLastCheck);
  console.log('amazonFailingSince:', status?.amazonSessionFailingSince);
  console.log('amazonExpiredAlertSent:', status?.amazonSessionExpiredAlertSent);
  console.log('amazonRestoreNoticeSent:', status?.amazonRestoreNoticeSent);

  const session = await db.collection('settings').findOne({ _id: 'session_amazon' });
  console.log('\n=== SESSION_AMAZON ===');
  console.log('capturedAt:', session?.capturedAt);
  console.log('lastSyncedAt:', session?.lastSyncedAt);

  process.exit(0);
}
main();
