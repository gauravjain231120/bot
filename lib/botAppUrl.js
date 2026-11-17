const axios = require('axios');

// Both bot Vercel deployments — one per Vercel account.
// When switching between free-tier accounts every ~15 days, the paused
// deployment returns 503 DEPLOYMENT_PAUSED. This module detects that and
// resolves to the working URL for Telegram web_app buttons.
const BOT_APP_URLS = [
  'https://bot-ruby-pi.vercel.app',
  'https://bot-seven-gules.vercel.app',
];

// Cache the active URL within a single serverless invocation.
let _activeAppUrl = null;

/**
 * Returns the active bot app URL, with failover.
 *
 * Priority:
 *  1. APP_URL env var (if explicitly set)
 *  2. VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL (current deployment)
 *  3. Probe both known URLs — return whichever responds first with a non-5xx
 */
async function getActiveAppUrl() {
  // Env var wins outright
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;

  // Already resolved this invocation
  if (_activeAppUrl) return _activeAppUrl;

  // Probe both URLs — a paused Vercel deployment returns 503
  for (const url of BOT_APP_URLS) {
    try {
      const res = await axios.head(url, { timeout: 5000, maxRedirects: 3 });
      if (res.status < 500) {
        _activeAppUrl = url;
        return url;
      }
    } catch (err) {
      const status = err.response && err.response.status;
      // 4xx is fine (the page exists, deployment is live) — only 5xx / network errors mean paused
      if (status && status < 500) {
        _activeAppUrl = url;
        return url;
      }
      // 503/502/504 or network error → try the next one
      continue;
    }
  }

  // Both failed — fall back to first URL (better than nothing)
  return BOT_APP_URLS[0];
}

module.exports = { getActiveAppUrl, BOT_APP_URLS };
