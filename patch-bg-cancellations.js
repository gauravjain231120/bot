const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

const amzTarget = `  const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
  const data = await fetchWithRetry(amzUrl);
  if (data && data._error) {
     console.error('Amazon local scrape failed:', data._error);
  } else if (data && Array.isArray(data.orders)) {
    await fetch(\`\${appUrl}/api/proxy-submit\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace: 'amazon', orders: data.orders })
    }).catch(console.error);
  }`;

const amzReplacement = `  const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
  const data = await fetchWithRetry(amzUrl);
  if (data && data._error) {
     console.error('Amazon local scrape failed:', data._error);
  } else if (data && Array.isArray(data.orders)) {
    // Also fetch Amazon cancellations locally!
    const amzCancelUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=ship_by_desc&date-range=last-90&fulfillmentType=mfn&orderStatus=canceled&program=easyship&forceOrdersTableRefreshTrigger=false';
    const cancelData = await fetchWithRetry(amzCancelUrl);
    
    const payload = { marketplace: 'amazon', orders: data.orders };
    if (cancelData && !cancelData._error && Array.isArray(cancelData.orders)) {
       payload.canceledOrders = cancelData.orders;
    }

    await fetch(\`\${appUrl}/api/proxy-submit\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify(payload)
    }).catch(console.error);
  }`;

code = code.replace(amzTarget, amzReplacement);

const mynTarget = `  const warehouseId = healthObj.warehouseId || '89623';
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
  }`;

const mynReplacement = `  const warehouseId = healthObj.warehouseId || '89623';
  const mynUrl = \`https://partnersapi.myntrainfo.com/api/mdirect/orders/v2/open?status=CREATED&fetchSize=100&start=0&sortBy=id&sortOrder=ASC&warehouseId=\${warehouseId}\`;
  const data = await fetchWithRetry(mynUrl);
  
  if (data && !data._error) {
    const orders = extractMyntraOrders(data);
    if (orders && orders.length >= 0) {
      // Also fetch Myntra cancellations locally!
      const mynCancelUrl = \`https://partnersapi.myntrainfo.com/api/mdirect/orders/cancel?fetchSize=100&start=0&sortBy=lastModifiedOn&sortOrder=DESC&warehouseId=\${warehouseId}\`;
      const cancelData = await fetchWithRetry(mynCancelUrl);
      
      const payload = { marketplace: 'myntra', orders };
      if (cancelData && !cancelData._error) {
         const canceledOrders = extractMyntraOrders(cancelData);
         if (canceledOrders) payload.canceledOrders = canceledOrders;
      }

      await fetch(\`\${appUrl}/api/proxy-submit\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
        body: JSON.stringify(payload)
      }).catch(console.error);
    }
  } else {
    console.error('Myntra local scrape failed:', data ? data._error : 'Unknown error');
  }`;

code = code.replace(mynTarget, mynReplacement);

fs.writeFileSync('browser-extension/background.js', code);
