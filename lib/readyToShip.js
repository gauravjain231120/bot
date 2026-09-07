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

// stock-manager's own /api/pending/check — the same duplicate-detector its
// manual "+Add" form uses to warn about a re-used order number. Used here so
// re-processing an order we've already added (e.g. if our own "seen" tracking
// ever gets cleared) is a no-op instead of stock-manager's addPending merging
// into the existing row and silently doubling its quantity/reservation.
async function alreadyTracked(orderId, resolvedSku, token) {
  if (!orderId) return false;
  try {
    const res = await axios.get(`${STOCK_MANAGER_URL}/api/pending/check`, {
      params: { orderId },
      headers: { Cookie: `auth=${token}` },
    });
    const uses = (res.data && res.data.uses) || [];
    return uses.some((u) => u.sku === resolvedSku);
  } catch (err) {
    console.error(`Ready to Ship dup-check failed for order ${orderId}:`, err.message);
    return false; // best-effort — fall through to attempting the add
  }
}

// Adds one line item to stock-manager's Ready to Ship queue (which reserves its
// stock there) — one row PER UNIT, not one row carrying the whole quantity, so
// 2 units of the same SKU on one order shows as 2 rows to pack, not a single
// row reading "Qty: 2". noMerge tells stock-manager's addPending to never fold
// this into an existing row for the same sku+order. Never throws — a
// stock-manager hiccup should never break the order alert itself; callers get
// back { ok, error? } to report if useful.
async function addToReadyToShip({ sku, qty, channel, orderId, placedAtMs, shipByMs }) {
  const token = process.env.STOCK_MANAGER_AUTH_TOKEN;
  if (!token) {
    return { ok: false, error: 'STOCK_MANAGER_AUTH_TOKEN not set' };
  }
  const resolvedSku = canonicalSku(sku);
  if (!resolvedSku) {
    return { ok: false, error: 'no SKU to add' };
  }

  if (await alreadyTracked(orderId, resolvedSku, token)) {
    return { ok: true, skipped: true };
  }

  const units = Math.max(1, Math.floor(qty) || 1);
  const ids = [];
  for (let i = 0; i < units; i++) {
    try {
      const res = await axios.post(
        `${STOCK_MANAGER_URL}/api/pending`,
        {
          sku: resolvedSku,
          qty: 1,
          channel,
          orderId: orderId != null ? String(orderId) : undefined,
          placedAt: placedAtMs ? new Date(placedAtMs).toISOString() : undefined,
          shipByAt: shipByMs ? new Date(shipByMs).toISOString() : undefined,
          noMerge: true,
        },
        { headers: { Cookie: `auth=${token}` } }
      );
      ids.push(res.data && res.data.id);
    } catch (err) {
      const msg = (err.response && err.response.data && err.response.data.error) || err.message;
      console.error(`Ready to Ship add failed for ${resolvedSku} (unit ${i + 1}/${units}):`, msg);
      return { ok: false, error: `${msg}${i > 0 ? ` (added ${i} of ${units} units first)` : ''}` };
    }
  }
  return { ok: true, ids };
}

module.exports = { addToReadyToShip, canonicalSku };
