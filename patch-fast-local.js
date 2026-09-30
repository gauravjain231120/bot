const fs = require('fs');

// Patch 1: app/api/proxy-submit/route.js
let apiCode = fs.readFileSync('app/api/proxy-submit/route.js', 'utf8');

const targetState = `    if (stateChange === 'cloud') {`;
const repState = `    if (stateChange === 'local') {
      const statusDoc = await db.collection('settings').findOne({ _id: 'status' }) || {};
      if (statusDoc[\`\${marketplace}ScrapeMode\`] !== 'local') {
        const Name = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
        await sendOwnerAlert(\`💻 <b>\${Name} switched to Local Browser</b>\\nManual toggle turned ON.\`, { silent: true }).catch(() => {});
      }
      await db.collection('settings').updateOne(
        { _id: 'status' },
        { $set: { [\`\${marketplace}ScrapeMode\`]: 'local', [\`\${marketplace}LastProxyCheck\`]: new Date().toISOString() } },
        { upsert: true }
      );
      return NextResponse.json({ ok: true, status: 'local-forced' });
    }

    if (stateChange === 'cloud') {`;

apiCode = apiCode.replace(targetState, repState);
fs.writeFileSync('app/api/proxy-submit/route.js', apiCode);

// Patch 2: browser-extension/background.js
let bgCode = fs.readFileSync('browser-extension/background.js', 'utf8');

const targetBg = `  if (msg.type === 'manual-mode-switch') {
    if (msg.mode === 'local') {
      if (msg.marketplace === 'amazon') runAmazonScrape();
      if (msg.marketplace === 'myntra') runMyntraScrape();
    } else {`;

const repBg = `  if (msg.type === 'manual-mode-switch') {
    if (msg.mode === 'local') {
      getConfig().then(({appUrl, syncSecret}) => {
        if (!appUrl || !syncSecret) return;
        fetch(\`\${appUrl}/api/proxy-submit\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
          body: JSON.stringify({ marketplace: msg.marketplace, stateChange: 'local' })
        }).catch(console.error);
      });
      if (msg.marketplace === 'amazon') runAmazonScrape();
      if (msg.marketplace === 'myntra') runMyntraScrape();
    } else {`;

bgCode = bgCode.replace(targetBg, repBg);
fs.writeFileSync('browser-extension/background.js', bgCode);

