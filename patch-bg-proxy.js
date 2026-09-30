const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

const oldMynScrape = `
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
`;

const newMynScrape = `
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
`;

code = code.replace(oldMynScrape, newMynScrape);

const oldAmzScrape = `
  if (localAmazon && health.amazon && health.amazon.state !== 'missing') {
    const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
    const data = await fetchWithRetry(amzUrl);
    if (data && Array.isArray(data.orders)) {
`;

const newAmzScrape = `
  if (localAmazon && health.amazon && health.amazon.state !== 'missing') {
    const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
    const data = await fetchWithRetry(amzUrl);
    if (data && data._error) {
       console.error('Amazon local scrape failed:', data._error);
    } else if (data && Array.isArray(data.orders)) {
`;

code = code.replace(oldAmzScrape, newAmzScrape);

fs.writeFileSync('browser-extension/background.js', code);
