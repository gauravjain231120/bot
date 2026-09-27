const axios = require('axios');
const { skuSuffix } = require('./skuSuffix');

const STOCK_MANAGER_URL = process.env.STOCK_MANAGER_URL || 'https://stock-manager-niko.vercel.app';
// stock-manager can cold-start (a few seconds) — 20s is generous, but a hung
// call must never hold up the order alert.
const STOCK_MANAGER_TIMEOUT_MS = 20000;

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
// stock-manager not answering at all (timeout / connection refused): further
// calls fail fast for a minute instead of each waiting out 20 s, so the order
// alert still goes out promptly (the owner is told to add it by hand).
const DOWN_HOLD_MS = 60 * 1000;
let downUntil = 0;
const noAnswer = (err) => !err.response && err.code !== 'ERR_CANCELED';

async function alreadyTracked(orderId, resolvedSku, token) {
  if (!orderId) return false;
  try {
    const res = await axios.get(`${STOCK_MANAGER_URL}/api/pending/check`, {
      params: { orderId },
      headers: { Cookie: `auth=${token}` },
      timeout: STOCK_MANAGER_TIMEOUT_MS,
    });
    const uses = (res.data && res.data.uses) || [];
    // stock-manager stores its own catalog SKU, whose brand prefix can differ
    // from ours (RR-/R- products) — compare the variant part, or a retried
    // alert would reserve the stock a second time.
    const want = skuSuffix(resolvedSku);
    return uses.some((u) => skuSuffix(u.sku) === want);
  } catch (err) {
    console.error(`Ready to Ship dup-check failed for order ${orderId}:`, err.message);
    if (noAnswer(err)) {
      downUntil = Date.now() + DOWN_HOLD_MS;
      throw err; // unreachable: don't risk a blind add either
    }
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

  if (Date.now() < downUntil) return { ok: false, error: 'stock-manager is not answering right now' };
  try {
    if (await alreadyTracked(orderId, resolvedSku, token)) {
      return { ok: true, skipped: true };
    }
  } catch (err) {
    return { ok: false, error: `stock-manager is not answering (${err.message})` };
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
        { headers: { Cookie: `auth=${token}` }, timeout: STOCK_MANAGER_TIMEOUT_MS }
      );
      ids.push(res.data && res.data.id);
    } catch (err) {
      if (noAnswer(err)) downUntil = Date.now() + DOWN_HOLD_MS;
      const msg = (err.response && err.response.data && err.response.data.error) || err.message;
      console.error(`Ready to Ship add failed for ${resolvedSku} (unit ${i + 1}/${units}):`, msg);
      return { ok: false, error: `${msg}${i > 0 ? ` (added ${i} of ${units} units first)` : ''}` };
    }
  }
  return { ok: true, ids };
}

module.exports = { addToReadyToShip, canonicalSku };
