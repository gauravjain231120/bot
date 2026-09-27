const axios = require('axios');
const { skuSuffix } = require('./skuSuffix');

// stock-manager's Ready to Ship queue, as the cancellation sweeps need it
// (lib/cancellationSweep.js). Every call either answers truthfully or THROWS:
// "couldn't reach stock-manager" must never read as "not in the queue" — that
// used to send still-queued units down the un-ship path (reversing an
// unrelated earlier shipment's stock) and flag them to the owner as missing.

const STOCK_MANAGER_URL = process.env.STOCK_MANAGER_URL || 'https://stock-manager-niko.vercel.app';

function authHeaders() {
  return { Cookie: `auth=${process.env.STOCK_MANAGER_AUTH_TOKEN}` };
}

// A hung stock-manager call must never hold up the cancellation check.
const TIMEOUT_MS = 20000;

/**
 * One order's rows in the queue: [{ id, sku, qty }]. Uses the light per-order
 * lookup (/api/pending/check) when stock-manager includes row ids; an older
 * stock-manager without them falls back to the full queue summary.
 */
async function queueRowsForOrder(orderId) {
  const id = String(orderId);
  const res = await axios.get(`${STOCK_MANAGER_URL}/api/pending/check`, { params: { orderId: id }, headers: authHeaders(), timeout: TIMEOUT_MS });
  const uses = (res.data && res.data.uses) || [];
  const queued = uses.filter((u) => u.where === 'QUEUE');
  if (queued.every((u) => u.id)) return queued.map((u) => ({ id: u.id, sku: u.sku, qty: Number(u.qty) || 1 }));
  const all = await axios.get(`${STOCK_MANAGER_URL}/api/pending/summary`, { headers: authHeaders(), timeout: TIMEOUT_MS });
  const rows = Array.isArray(all.data && all.data.rows) ? all.data.rows : [];
  return rows.filter((r) => String(r.orderId) === id).map((r) => ({ id: r.id, sku: r.sku, qty: Number(r.qty) || 1 }));
}

/**
 * Takes up to `qty` units of variant `suffix` out of `rows` (DELETE with a
 * quantity, so a manually merged qty-2 row loses only what was cancelled).
 * `onRemoved(n)` is awaited after EACH successful delete so the caller can save
 * progress — a failure half-way then resumes where it stopped instead of
 * re-counting units that are already gone. Throws on a failed delete.
 * Mutates `rows` (removed quantities come off) and returns units removed.
 */
async function removeUnits(rows, suffix, qty, onRemoved = async () => {}) {
  let removed = 0;
  for (const row of rows) {
    if (removed >= qty) break;
    if (row.qty <= 0 || skuSuffix(row.sku) !== suffix) continue;
    const take = Math.min(row.qty, qty - removed);
    await axios.delete(`${STOCK_MANAGER_URL}/api/pending/${row.id}`, { headers: authHeaders(), timeout: TIMEOUT_MS, data: { qty: take } });
    row.qty -= take;
    removed += take;
    await onRemoved(take);
  }
  return removed;
}

/**
 * The part of a cancelled line that wasn't in the queue had already been
 * marked shipped — stock-manager's /api/pending/unship-cancelled puts that
 * stock back (and remembers it, so a later return scan of the same parcel
 * doesn't add it again). Returns { reversed, remaining }; throws when
 * stock-manager can't be reached (retry, never "unresolved").
 */
async function unshipLine({ orderId, sku, qty, altOrderIds = [] }) {
  let res;
  try {
    res = await axios.post(
      `${STOCK_MANAGER_URL}/api/pending/unship-cancelled`,
      { orderId: String(orderId), sku, qty, ...(altOrderIds.length ? { altOrderIds } : {}) },
      { headers: authHeaders(), timeout: TIMEOUT_MS }
    );
  } catch (err) {
    // stock-manager answered but refused (e.g. reversing would push stock
    // negative) — nothing to retry, a person has to look.
    const status = err.response && err.response.status;
    if (status && status >= 400 && status < 500) {
      return { reversed: 0, remaining: qty, error: (err.response.data && err.response.data.error) || `HTTP ${status}` };
    }
    throw err;
  }
  const data = res.data || {};
  return { reversed: data.reversedQty || 0, remaining: data.remaining || 0 };
}

module.exports = { queueRowsForOrder, removeUnits, unshipLine };
