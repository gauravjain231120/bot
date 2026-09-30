const fs = require('fs');
let code = fs.readFileSync('lib/checkAmazonOrders.js', 'utf8');

const newLogic = `
  const db = await getDb();
  const settings = db.collection('settings');
  const statusDoc = await settings.findOne({ _id: 'status' }) || {};

  if (!proxyData) {
    if (statusDoc.amazonLastProxyCheck) {
      const msSinceProxy = Date.now() - new Date(statusDoc.amazonLastProxyCheck).getTime();
      if (msSinceProxy < 10 * 60 * 1000) {
        // Extension is actively checking, skip cloud check
        return;
      }
    }
    // We are falling back to Cloud
    if (statusDoc.amazonScrapeMode === 'local') {
      await sendOwnerAlert('☁️ <b>Amazon switched to Cloud Backup</b>\\nThe laptop/browser went offline.', { silent: true }).catch(() => {});
      await settings.updateOne({ _id: 'status' }, { $set: { amazonScrapeMode: 'cloud' } });
    }
    // JITTER: Randomly delay 1 to 12 seconds so the WAF doesn't see perfect robotic timing.
    const jitterMs = Math.floor(Math.random() * 11000) + 1000;
    await new Promise(r => setTimeout(r, jitterMs));
  } else {
    // Proxy (Extension) is checking
    if (statusDoc.amazonScrapeMode !== 'local') {
      await sendOwnerAlert('💻 <b>Amazon switched to Local Browser</b>\\nThe laptop/browser is online and checking orders.', { silent: true }).catch(() => {});
    }
    await settings.updateOne({ _id: 'status' }, { $set: { amazonLastProxyCheck: new Date().toISOString(), amazonScrapeMode: 'local' } }, { upsert: true });
  }
`;

// Extract the top part of the function to replace it precisely
const match = code.match(/async function runCheckAmazonOrders[\s\S]*?const sessionDoc = await settings\.findOne/);
if (match) {
  const replacement = `async function runCheckAmazonOrders({ proxyData = null } = {}) {
${newLogic}

  const sessionDoc = await settings.findOne`;
  code = code.replace(match[0], replacement);
  fs.writeFileSync('lib/checkAmazonOrders.js', code);
}
