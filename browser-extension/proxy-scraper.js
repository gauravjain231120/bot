async function fetchWithRetry(url, maxTries = 2) {
  let lastErr;
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) return null; // blocked or logged out
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

async function runProxyScraper(health, appUrl, syncSecret, localAmazon, localMyntra) {
  if (localAmazon && health.amazon && health.amazon.state !== 'missing') {
    // Fetch Amazon Unshipped
    const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
    const data = await fetchWithRetry(amzUrl);
    if (data && Array.isArray(data.orders)) {
      await fetch(`${appUrl}/api/proxy-submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sync-secret': syncSecret
        },
        body: JSON.stringify({ marketplace: 'amazon', orders: data.orders })
      }).catch(console.error);
    }
  }

  if (localMyntra && health.myntra && health.myntra.state !== 'missing') {
    const warehouseId = health.warehouseId || '89623';
    const mynUrl = `https://partnersapi.myntrainfo.com/api/mdirect/orders/v2/open?status=CREATED&fetchSize=100&start=0&sortBy=id&sortOrder=ASC&warehouseId=${warehouseId}`;
    const data = await fetchWithRetry(mynUrl);
    
    // Myntra format: data is the response. extractOrders(data) is needed... wait, Vercel checkOrders.js uses extractOrders!
    // But Vercel's extractOrders takes the raw res.data. Let's just pass data as orders.
    // In checkOrders.js, we did `orders = proxyData ? proxyData : await fetchOpenOrders(headers);`
    // Wait, fetchOpenOrders returns the extracted orders array!
    // So the extension must extract them, OR we send raw data and Vercel extracts.
    // If extension extracts them: `data.status && data.status.statusCode === 'OK' ? data.orders : []`
    
    // Actually, Myntra's format is res.data.elements or something.
    // Let's check myntra.js for extractOrders!
  }
}
