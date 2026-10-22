const axios = require('axios');

// Both Stock Manager Vercel deployments — one per Vercel account.
// When switching between free-tier accounts every ~15 days, the paused
// deployment returns 503 DEPLOYMENT_PAUSED. This module detects that and
// transparently falls over to the other URL, caching the result so every
// subsequent call in the same serverless invocation uses the right one.
const STOCK_MANAGER_URLS = [
  'https://stock-manager-niko.vercel.app',
  'https://stock-manager-self-nine.vercel.app',
];

// Env var wins if explicitly set, else defaults to niko
let _active = process.env.STOCK_MANAGER_URL || null;

function isDeploymentDown(err) {
  if (!err) return false;
  // Vercel deployment paused returns 503; 502/504 are gateway/unreachable errors
  if (err.response && (err.response.status === 503 || err.response.status === 502 || err.response.status === 504)) {
    return true;
  }
  // Network / DNS / connection errors
  if (!err.response && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET')) {
    return true;
  }
  return false;
}

function getStockManagerUrl() {
  return _active || STOCK_MANAGER_URLS[0];
}

/**
 * Wraps an async function `fn(stockManagerBaseUrl)` with automatic failover.
 * If the primary URL returns 503 or is unreachable, the request is retried on the alternate URL.
 *
 * Usage:
 *   const res = await withFailover(url =>
 *     axios.get(`${url}/api/pending/check`, { params, headers, timeout })
 *   );
 */
async function withFailover(fn) {
  const primary = getStockManagerUrl();
  try {
    const result = await fn(primary);
    _active = primary;
    return result;
  } catch (err) {
    if (isDeploymentDown(err)) {
      const alt = STOCK_MANAGER_URLS.find(u => u !== primary) || STOCK_MANAGER_URLS[0];
      if (alt && alt !== primary) {
        console.warn(`[stockManagerUrl] Primary ${primary} failed (${err.response ? err.response.status : err.code}). Retrying with alternate ${alt}...`);
        const result = await fn(alt);
        _active = alt; // cache working URL
        return result;
      }
    }
    throw err;
  }
}

module.exports = { getStockManagerUrl, withFailover, STOCK_MANAGER_URLS };
