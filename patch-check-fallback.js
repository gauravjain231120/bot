const fs = require('fs');

function patchFallback(file, key) {
  let code = fs.readFileSync(file, 'utf8');
  
  const target = `    if (statusDoc.${key}LastProxyCheck) {
      const msSinceProxy = Date.now() - new Date(statusDoc.${key}LastProxyCheck).getTime();
      if (msSinceProxy < 10 * 60 * 1000) {`;

  const replacement = `    if (statusDoc.${key}LastProxyCheck) {
      const msSinceProxy = Date.now() - new Date(statusDoc.${key}LastProxyCheck).getTime();
      // Default to 5 mins as requested, but if they set interval to 5+, pad it by 90s so it doesn't false-alarm
      const userIntervalMs = (statusDoc.${key}ProxyInterval || 4) * 60 * 1000;
      const fallbackMs = Math.max(5 * 60 * 1000, userIntervalMs + 90000); 
      
      if (msSinceProxy < fallbackMs) {`;

  code = code.replace(target, replacement);
  fs.writeFileSync(file, code);
}

patchFallback('lib/checkAmazonOrders.js', 'amazon');
patchFallback('lib/checkOrders.js', 'myntra');
