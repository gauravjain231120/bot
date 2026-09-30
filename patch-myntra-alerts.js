const fs = require('fs');
let code = fs.readFileSync('lib/checkOrders.js', 'utf8');

const newLogic = `
  const db = await getDb();
  const settings = db.collection('settings');
  const statusDoc = await settings.findOne({ _id: 'status' }) || {};

  if (!proxyData) {
    if (statusDoc.myntraLastProxyCheck) {
      const msSinceProxy = Date.now() - new Date(statusDoc.myntraLastProxyCheck).getTime();
      if (msSinceProxy < 10 * 60 * 1000) {
        // Extension is actively checking, skip cloud check
        return;
      }
    }
    // We are falling back to Cloud
    if (statusDoc.myntraScrapeMode === 'local') {
      await sendOwnerAlert('☁️ <b>Myntra switched to Cloud Backup</b>\\nThe laptop/browser went offline.', { silent: true }).catch(() => {});
      await settings.updateOne({ _id: 'status' }, { $set: { myntraScrapeMode: 'cloud' } });
    }
  } else {
    // Proxy (Extension) is checking
    if (statusDoc.myntraScrapeMode !== 'local') {
      await sendOwnerAlert('💻 <b>Myntra switched to Local Browser</b>\\nThe laptop/browser is online and checking orders.', { silent: true }).catch(() => {});
    }
    await settings.updateOne({ _id: 'status' }, { $set: { myntraLastProxyCheck: new Date().toISOString(), myntraScrapeMode: 'local' } }, { upsert: true });
  }
`;

const match = code.match(/async function runCheckOrders[\s\S]*?const sessionDoc = await settings\.findOne/);
if (match) {
  const replacement = `async function runCheckOrders({ proxyData = null } = {}) {
${newLogic}

  const sessionDoc = await settings.findOne`;
  code = code.replace(match[0], replacement);
  fs.writeFileSync('lib/checkOrders.js', code);
}
