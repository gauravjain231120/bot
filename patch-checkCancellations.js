const fs = require('fs');
let code = fs.readFileSync('lib/checkCancellations.js', 'utf8');

const target = `  const isFirstRun = (await seenCancellations.estimatedDocumentCount()) === 0;

  let orders;
  try {
    orders = await fetchCancelledOrders(headers);
  } catch (err) {`;

const replacement = `  const isFirstRun = (await seenCancellations.estimatedDocumentCount()) === 0;

  let orders;
  const statusDoc = await settings.findOne({ _id: 'status' });
  try {
    if (statusDoc && statusDoc.myntraScrapeMode === 'local') {
      const proxyDoc = await settings.findOne({ _id: 'proxy_canceled_myntra' });
      if (proxyDoc && proxyDoc.data) {
        // If data is older than 2 hours, it's stale (proxy stopped), fall back to cloud fetch
        const ageMs = Date.now() - new Date(proxyDoc.updatedAt || 0).getTime();
        if (ageMs < 2 * 60 * 60 * 1000) {
          orders = proxyDoc.data;
        }
      }
    }
    
    if (!orders) {
      orders = await fetchCancelledOrders(headers);
    }
  } catch (err) {`;

code = code.replace(target, replacement);
fs.writeFileSync('lib/checkCancellations.js', code);
