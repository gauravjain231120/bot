const axios = require('axios');

const STOCK_MANAGER_URL = process.env.STOCK_MANAGER_URL || 'https://stock-manager-niko.vercel.app';

// stock-manager's Product catalog always uses the "RRC-" brand prefix (verified:
// 327 of 328 current products) regardless of which prefix a marketplace order
// SKU actually shows (RRC-/RR-/R- for the same variant). Bundle-code mapping
// (e.g. 012 -> 002) is handled inside stock-manager's own addPending, so it is
// NOT applied here — only the brand prefix needs fixing before calling its API.
function canonicalSku(sku) {
  if (!sku) return null;
  const idx = sku.indexOf('-');
  const rest = idx === -1 ? sku : sku.slice(idx + 1);
  return `RRC-${rest.trim().toUpperCase()}`;
}

// Adds one line item to stock-manager's Ready to Ship queue (which reserves its
// stock there). Never throws — a stock-manager hiccup should never break the
// order alert itself; callers get back { ok, error? } to report if useful.
async function addToReadyToShip({ sku, qty, channel, orderId, placedAtMs, shipByMs }) {
  const token = process.env.STOCK_MANAGER_AUTH_TOKEN;
  if (!token) {
    return { ok: false, error: 'STOCK_MANAGER_AUTH_TOKEN not set' };
  }
  const resolvedSku = canonicalSku(sku);
  if (!resolvedSku) {
    return { ok: false, error: 'no SKU to add' };
  }

  try {
    const res = await axios.post(
      `${STOCK_MANAGER_URL}/api/pending`,
      {
        sku: resolvedSku,
        qty: qty || 1,
        channel,
        orderId: orderId != null ? String(orderId) : undefined,
        placedAt: placedAtMs ? new Date(placedAtMs).toISOString() : undefined,
        shipByAt: shipByMs ? new Date(shipByMs).toISOString() : undefined,
      },
      { headers: { Cookie: `auth=${token}` } }
    );
    return { ok: true, id: res.data && res.data.id };
  } catch (err) {
    const msg = (err.response && err.response.data && err.response.data.error) || err.message;
    console.error(`Ready to Ship add failed for ${resolvedSku}:`, msg);
    return { ok: false, error: msg };
  }
}

module.exports = { addToReadyToShip, canonicalSku };
