const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

const oldRunProxy = `async function runProxyScraper(health, appUrl, syncSecret, localAmazon, localMyntra) {
  if (localAmazon && health.amazon && health.amazon.state !== 'missing') {
    const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
    const data = await fetchWithRetry(amzUrl);
    if (data && data._error) {
       console.error('Amazon local scrape failed:', data._error);
    } else if (data && Array.isArray(data.orders)) {
      await fetch(\`\${appUrl}/api/proxy-submit\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
        body: JSON.stringify({ marketplace: 'amazon', orders: data.orders })
      }).catch(console.error);
    }
  }

  if (localMyntra && health.myntra && health.myntra.state !== 'missing') {
    const warehouseId = health.warehouseId || '89623';
    const mynUrl = \`https://partnersapi.myntrainfo.com/api/mdirect/orders/v2/open?status=CREATED&fetchSize=100&start=0&sortBy=id&sortOrder=ASC&warehouseId=\${warehouseId}\`;
    const data = await fetchWithRetry(mynUrl);
    if (data && !data._error) {
      const orders = extractMyntraOrders(data);
      if (orders && orders.length >= 0) { // even if 0, we push to let vercel know we checked
        await fetch(\`\${appUrl}/api/proxy-submit\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
          body: JSON.stringify({ marketplace: 'myntra', orders })
        }).catch(console.error);
      }
    } else {
      console.error('Myntra local scrape failed:', data ? data._error : 'Unknown error');
    }
  }
}`;

const newRunProxy = `async function runAmazonScrape() {
  const { appUrl, syncSecret } = await getConfig();
  if (!appUrl || !syncSecret) return;
  const healthObj = (await chrome.storage.local.get(['health'])).health || {};
  if (healthObj.amazon && healthObj.amazon.state === 'missing') return;

  const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
  const data = await fetchWithRetry(amzUrl);
  if (data && data._error) {
     console.error('Amazon local scrape failed:', data._error);
  } else if (data && Array.isArray(data.orders)) {
    await fetch(\`\${appUrl}/api/proxy-submit\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace: 'amazon', orders: data.orders })
    }).catch(console.error);
  }
}

async function runMyntraScrape() {
  const { appUrl, syncSecret } = await getConfig();
  if (!appUrl || !syncSecret) return;
  const healthObj = (await chrome.storage.local.get(['health'])).health || {};
  if (healthObj.myntra && healthObj.myntra.state === 'missing') return;

  const warehouseId = healthObj.warehouseId || '89623';
  const mynUrl = \`https://partnersapi.myntrainfo.com/api/mdirect/orders/v2/open?status=CREATED&fetchSize=100&start=0&sortBy=id&sortOrder=ASC&warehouseId=\${warehouseId}\`;
  const data = await fetchWithRetry(mynUrl);
  if (data && !data._error) {
    const orders = extractMyntraOrders(data);
    if (orders && orders.length >= 0) {
      await fetch(\`\${appUrl}/api/proxy-submit\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
        body: JSON.stringify({ marketplace: 'myntra', orders })
      }).catch(console.error);
    }
  } else {
    console.error('Myntra local scrape failed:', data ? data._error : 'Unknown error');
  }
}

async function ensureProxyAlarms() {
  const stored = await chrome.storage.local.get(['localMyntra', 'localAmazon', 'proxyPeriodAmazon', 'proxyPeriodMyntra']);
  if (stored.localAmazon) {
    chrome.alarms.create('proxy-scrape-amazon', { periodInMinutes: stored.proxyPeriodAmazon || 5 });
  } else {
    chrome.alarms.clear('proxy-scrape-amazon');
  }
  
  if (stored.localMyntra) {
    chrome.alarms.create('proxy-scrape-myntra', { periodInMinutes: stored.proxyPeriodMyntra || 2 });
  } else {
    chrome.alarms.clear('proxy-scrape-myntra');
  }
}`;

code = code.replace(oldRunProxy, newRunProxy);

// Remove proxy scraper from checkHealth
const oldHealthProxy = `    try {
      const { localAmazon, localMyntra } = await chrome.storage.local.get(['localAmazon', 'localMyntra']);
      if (localAmazon || localMyntra) {
        await runProxyScraper(health, appUrl, syncSecret, localAmazon, localMyntra);
      }
    } catch (err) {
      console.error('Proxy scraper failed:', err);
    }`;

code = code.replace(oldHealthProxy, '');

// Add alarm listeners for proxy-scrape-amazon and proxy-scrape-myntra
const oldAlarmListener = `chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEALTH_ALARM) {`;

const newAlarmListener = `chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'proxy-scrape-amazon') {
    runAmazonScrape();
  } else if (alarm.name === 'proxy-scrape-myntra') {
    runMyntraScrape();
  } else if (alarm.name === HEALTH_ALARM) {`;

code = code.replace(oldAlarmListener, newAlarmListener);

// Add listener for update-proxy-alarms
const oldUpdateListener = `  if (msg.type === 'test-cloud') {
    handleTestCloud(msg.marketplace).then(sendResponse);
    return true;
  }`;

const newUpdateListener = `  if (msg.type === 'test-cloud') {
    handleTestCloud(msg.marketplace).then(sendResponse);
    return true;
  }
  if (msg.type === 'update-proxy-alarms') {
    ensureProxyAlarms().then(() => { if (sendResponse) sendResponse({ok: true}); });
    return true;
  }`;

code = code.replace(oldUpdateListener, newUpdateListener);

// Inject ensureProxyAlarms into startup
const oldStartup = `chrome.runtime.onStartup.addListener(() => {
  ensureAlarms().then(updateBadge);
});`;

const newStartup = `chrome.runtime.onStartup.addListener(() => {
  ensureAlarms().then(updateBadge);
  ensureProxyAlarms();
});`;

code = code.replace(oldStartup, newStartup);

fs.writeFileSync('browser-extension/background.js', code);
