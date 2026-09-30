const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

// 1. Add interval to Amazon payload
const amzTarget = `    const payload = { marketplace: 'amazon', orders: data.orders };`;
const amzRep = `    const pAmz = (await chrome.storage.local.get(['proxyPeriodAmazon'])).proxyPeriodAmazon || 5;
    const payload = { marketplace: 'amazon', orders: data.orders, interval: pAmz };`;
code = code.replace(amzTarget, amzRep);

// 2. Add interval to Myntra payload
const mynTarget = `      const payload = { marketplace: 'myntra', orders };`;
const mynRep = `      const pMyn = (await chrome.storage.local.get(['proxyPeriodMyntra'])).proxyPeriodMyntra || 2;
      const payload = { marketplace: 'myntra', orders, interval: pMyn };`;
code = code.replace(mynTarget, mynRep);

// 3. Add manual-mode-switch listener
const msgTarget = `  if (msg.type === 'update-proxy-alarms') {
    ensureProxyAlarms().then(() => { if (sendResponse) sendResponse({ok: true}); });
    return true;
  }`;

const msgRep = `  if (msg.type === 'update-proxy-alarms') {
    ensureProxyAlarms().then(() => { if (sendResponse) sendResponse({ok: true}); });
    return true;
  }
  if (msg.type === 'manual-mode-switch') {
    if (msg.mode === 'local') {
      if (msg.marketplace === 'amazon') runAmazonScrape();
      if (msg.marketplace === 'myntra') runMyntraScrape();
    } else {
      getConfig().then(({appUrl, syncSecret}) => {
        if (!appUrl || !syncSecret) return;
        fetch(\`\${appUrl}/api/proxy-submit\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
          body: JSON.stringify({ marketplace: msg.marketplace, stateChange: 'cloud' })
        }).catch(console.error);
      });
    }
    return true;
  }`;
code = code.replace(msgTarget, msgRep);

fs.writeFileSync('browser-extension/background.js', code);
