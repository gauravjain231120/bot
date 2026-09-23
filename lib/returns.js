const axios = require('axios');

const STOCK_MANAGER_URL = process.env.STOCK_MANAGER_URL || 'https://stock-manager-niko.vercel.app';

/**
 * Logs one Myntra return into stock-manager — the exact same write path its
 * own "Log a Return" / scan-the-label flow uses (`POST /api/register`,
 * `action: 'RETURN'`), authenticated the same way `addToReadyToShip()`
 * already is (`Cookie: auth=<STOCK_MANAGER_AUTH_TOKEN>`). This is the write
 * half of the dashboard's "Scan a Myntra return" card — resolving happens
 * via `resolveReturnByTrackingId()` + `lookupProductBySku()` (§19/§21,
 * lib/myntra.js + lib/stock.js), this function only ever writes what's
 * already been resolved and confirmed. Never throws — callers get back
 * `{ ok, error? }`.
 */
// `channel` defaults to MYNTRA so the Myntra Scan Return flow is unchanged;
// the Amazon Return page passes 'AMAZON'.
const RETURN_TYPES = ['CUSTOMER', 'RTO', 'UNKNOWN'];

// `returnType` (customer return vs RTO) is stored on the stock-manager row;
// anything missing/unrecognised is sent as UNKNOWN.
async function addReturnToStockManager({ sku, qty, trackingId, condition, channel = 'MYNTRA', returnType, orderId }) {
  const token = process.env.STOCK_MANAGER_AUTH_TOKEN;
  if (!token) {
    return { ok: false, error: 'STOCK_MANAGER_AUTH_TOKEN not set' };
  }
  if (!sku) {
    return { ok: false, error: 'no SKU to add' };
  }
  try {
    await axios.post(
      `${STOCK_MANAGER_URL}/api/register`,
      {
        sku,
        action: 'RETURN',
        qty: Math.max(1, Math.floor(qty) || 1),
        channel,
        trackingId: trackingId || undefined,
        condition: condition || 'GOOD',
        returnType: RETURN_TYPES.includes(returnType) ? returnType : 'UNKNOWN',
        // Only sent when known — stock-manager stores it on the return row.
        orderId: orderId || undefined,
      },
      { headers: { Cookie: `auth=${token}` } },
    );
    return { ok: true };
  } catch (err) {
    const msg = (err.response && err.response.data && err.response.data.error) || err.message;
    return { ok: false, error: msg };
  }
}

module.exports = { addReturnToStockManager };
