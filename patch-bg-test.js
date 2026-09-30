const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

const testLogic = `
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'test-local') {
    handleTestLocal(msg.marketplace).then(sendResponse);
    return true;
  }
  if (msg.type === 'test-cloud') {
    handleTestCloud(msg.marketplace).then(sendResponse);
    return true;
  }
});

async function handleTestLocal(marketplace) {
  try {
    const { appUrl, syncSecret } = await getConfig();
    let orders = [];
    
    if (marketplace === 'amazon') {
      const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
      const data = await fetchWithRetry(amzUrl);
      if (data && Array.isArray(data.orders)) orders = data.orders;
      else return { ok: false, error: 'Could not fetch from Amazon' };
    } else {
      const healthObj = (await chrome.storage.local.get(['health'])).health || {};
      const warehouseId = healthObj.warehouseId || '89623';
      const mynUrl = \`https://partnersapi.myntrainfo.com/api/mdirect/orders/v2/open?status=CREATED&fetchSize=100&start=0&sortBy=id&sortOrder=ASC&warehouseId=\${warehouseId}\`;
      const data = await fetchWithRetry(mynUrl);
      orders = extractMyntraOrders(data);
      if (!orders) return { ok: false, error: 'Could not fetch from Myntra' };
    }

    const res = await fetch(\`\${appUrl}/api/proxy-test\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace, type: 'local', orders })
    });
    
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleTestCloud(marketplace) {
  try {
    const { appUrl, syncSecret } = await getConfig();
    const res = await fetch(\`\${appUrl}/api/proxy-test\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace, type: 'cloud' })
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
`;

code = code + '\n' + testLogic;
fs.writeFileSync('browser-extension/background.js', code);
