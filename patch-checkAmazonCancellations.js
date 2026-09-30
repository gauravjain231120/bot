const fs = require('fs');
let code = fs.readFileSync('lib/checkAmazonCancellations.js', 'utf8');

const target = `  const isFirstRun = (await seenAmazonCancellations.estimatedDocumentCount()) === 0;

  let orders;
  try {
    orders = Object.values(await fetchCancelledByProgram(headers)).flat();
  } catch (err) {`;

const replacement = `  const isFirstRun = (await seenAmazonCancellations.estimatedDocumentCount()) === 0;

  let orders;
  const statusDoc = await settings.findOne({ _id: 'status' });
  try {
    if (statusDoc && statusDoc.amazonScrapeMode === 'local') {
      const proxyDoc = await settings.findOne({ _id: 'proxy_canceled_amazon' });
      if (proxyDoc && proxyDoc.data) {
        const ageMs = Date.now() - new Date(proxyDoc.updatedAt || 0).getTime();
        if (ageMs < 2 * 60 * 60 * 1000) {
          orders = proxyDoc.data;
        }
      }
    }

    if (!orders) {
      orders = Object.values(await fetchCancelledByProgram(headers)).flat();
    }
  } catch (err) {`;

code = code.replace(target, replacement);
fs.writeFileSync('lib/checkAmazonCancellations.js', code);
