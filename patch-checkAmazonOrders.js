const fs = require('fs');
let code = fs.readFileSync('lib/checkAmazonOrders.js', 'utf8');

// 1. Change signature
code = code.replace(
  'async function runCheckAmazonOrders() {',
  'async function runCheckAmazonOrders({ proxyData = null } = {}) {'
);

// 2. Handle proxy skipping & jitter
const jitterBlock = `
  const db = await getDb();
  const settings = db.collection('settings');

  if (!proxyData) {
    const statusDoc = await settings.findOne({ _id: 'status' });
    if (statusDoc && statusDoc.amazonLastProxyCheck) {
      const msSinceProxy = Date.now() - new Date(statusDoc.amazonLastProxyCheck).getTime();
      if (msSinceProxy < 10 * 60 * 1000) {
        console.log(\`Skipping Amazon cloud check. Extension checked \${Math.round(msSinceProxy/1000)}s ago.\`);
        return;
      }
    }
    // JITTER: Randomly delay 1 to 12 seconds so the WAF doesn't see perfect robotic timing.
    const jitterMs = Math.floor(Math.random() * 11000) + 1000;
    await new Promise(r => setTimeout(r, jitterMs));
  } else {
    // Record that the proxy just checked
    await settings.updateOne({ _id: 'status' }, { $set: { amazonLastProxyCheck: new Date().toISOString() } }, { upsert: true });
  }
`;

code = code.replace(
  /\/\/ JITTER: Randomly delay[\s\S]*?const settings = db.collection\('settings'\);/,
  jitterBlock.trim()
);

// 3. Skip header check if proxyData
code = code.replace(
  /const sessionDoc = await settings\.findOne\(\{ _id: 'session_amazon' \}\);[\s\S]*?const headers = sessionDoc\.headers;/,
  `const sessionDoc = await settings.findOne({ _id: 'session_amazon' });
  if (!proxyData && (!sessionDoc || !sessionDoc.headers)) {
    await settings.updateOne(
      { _id: 'status' },
      { $set: { amazonLastError: \`\${new Date().toISOString()} No Amazon session saved yet\` } },
      { upsert: true }
    );
    await noteSessionFailure(
      settings,
      'amazon',
      '⚠️ Amazon session missing. Paste a fresh session on the admin page (or let the browser extension sync one).',
      { sessionDoc: null }
    );
    throw new Error('No Amazon session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc ? sessionDoc.headers : null;`
);

// 4. Use proxyData instead of fetching
code = code.replace(
  /orders = Object\.values\(await fetchUnshippedByProgram\(headers\)\)\.flat\(\);/,
  `orders = proxyData ? proxyData : Object.values(await fetchUnshippedByProgram(headers)).flat();`
);

// 5. Update exports
code = code.replace(
  /module\.exports = \{ runCheckAmazonOrders, sweepPartlyCancelledAmazonOrders \};/,
  `module.exports = { runCheckAmazonOrders, sweepPartlyCancelledAmazonOrders };`
);

fs.writeFileSync('lib/checkAmazonOrders.js', code);
