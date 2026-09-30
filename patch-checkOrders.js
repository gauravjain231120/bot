const fs = require('fs');
let code = fs.readFileSync('lib/checkOrders.js', 'utf8');

// 1. Change signature
code = code.replace(
  'async function runCheckOrders() {',
  'async function runCheckOrders({ proxyData = null } = {}) {'
);

// 2. Handle proxy skipping & setting
const initialBlock = `
  const db = await getDb();
  const settings = db.collection('settings');
`;

const proxyLogic = `
  const db = await getDb();
  const settings = db.collection('settings');

  if (!proxyData) {
    const statusDoc = await settings.findOne({ _id: 'status' });
    if (statusDoc && statusDoc.myntraLastProxyCheck) {
      const msSinceProxy = Date.now() - new Date(statusDoc.myntraLastProxyCheck).getTime();
      if (msSinceProxy < 10 * 60 * 1000) {
        console.log(\`Skipping Myntra cloud check. Extension checked \${Math.round(msSinceProxy/1000)}s ago.\`);
        return;
      }
    }
  } else {
    await settings.updateOne({ _id: 'status' }, { $set: { myntraLastProxyCheck: new Date().toISOString() } }, { upsert: true });
  }
`;

code = code.replace(
  initialBlock.trim(),
  proxyLogic.trim()
);

// 3. Skip header check if proxyData
code = code.replace(
  /const sessionDoc = await settings\.findOne\(\{ _id: 'session' \}\);[\s\S]*?const headers = sessionDoc\.headers;/,
  `const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!proxyData && (!sessionDoc || !sessionDoc.headers)) {
    await settings.updateOne(
      { _id: 'status' },
      { $set: { lastError: \`\${new Date().toISOString()} No session saved yet\` } },
      { upsert: true }
    );
    await noteSessionFailure(
      settings,
      'myntra',
      '⚠️ Myntra session missing. Paste a fresh session on the admin page (or let the browser extension sync one).',
      { sessionDoc: null }
    );
    throw new Error('No session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc ? sessionDoc.headers : null;`
);

// 4. Use proxyData instead of fetching
code = code.replace(
  /orders = await fetchOpenOrders\(headers\);/,
  `orders = proxyData ? proxyData : await fetchOpenOrders(headers);`
);

fs.writeFileSync('lib/checkOrders.js', code);
