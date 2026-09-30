const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

const proxyCode = `
async function fetchWithRetry(url, maxTries = 2) {
  let lastErr;
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) return null;
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

function extractMyntraOrders(json) {
  const data = json && json.data;
  if (!Array.isArray(data)) return [];
  const orders = [];
  for (const item of data) {
    if (item && Array.isArray(item.fulfilmentOrderGroups)) {
      orders.push(...item.fulfilmentOrderGroups);
    } else if (item && item.orderId) {
      orders.push(item);
    }
  }
  return orders;
}

async function runProxyScraper(health, appUrl, syncSecret, localAmazon, localMyntra) {
  if (localAmazon && health.amazon && health.amazon.state !== 'missing') {
    const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
    const data = await fetchWithRetry(amzUrl);
    if (data && Array.isArray(data.orders)) {
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
    const orders = extractMyntraOrders(data);
    if (orders && orders.length >= 0) { // even if 0, we push to let vercel know we checked
      await fetch(\`\${appUrl}/api/proxy-submit\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
        body: JSON.stringify({ marketplace: 'myntra', orders })
      }).catch(console.error);
    }
  }
}
`;

// Insert the code
code = code.replace(
  'const RECENT_SYNC_GRACE_MS =',
  proxyCode + '\nconst RECENT_SYNC_GRACE_MS ='
);

// Inject the call inside checkHealth()
const injection = `
    await chrome.storage.local.set({ health: { ...health, at: new Date().toISOString() } });

    try {
      const { localAmazon, localMyntra } = await chrome.storage.local.get(['localAmazon', 'localMyntra']);
      if (localAmazon || localMyntra) {
        await runProxyScraper(health, appUrl, syncSecret, localAmazon, localMyntra);
      }
    } catch (err) {
      console.error('Proxy scraper failed:', err);
    }
`;
code = code.replace(
  `await chrome.storage.local.set({ health: { ...health, at: new Date().toISOString() } });`,
  injection.trim()
);

fs.writeFileSync('browser-extension/background.js', code);
