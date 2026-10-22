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
 * One queue row, `take` units off it. With `requestId`, stock-manager answers a
 * repeat of the same request with what it took the first time (a delete whose
 * answer got lost is re-sent, never applied twice). Returns the units it says
 * it took — a row already gone is 0, never "removed". Throws on failure.
 */
async function cancelQueueRow(rowId, take, requestId) {
  const res = await axios.delete(`${STOCK_MANAGER_URL}/api/pending/${rowId}`, {
    headers: authHeaders(),
    timeout: TIMEOUT_MS,
    data: { qty: take, ...(requestId ? { requestId } : {}) },
  });
  return Math.max(0, Math.min(take, Number(res.data && res.data.cancelled) || 0));
}

/**
 * Takes up to `qty` units of variant `suffix` out of `rows` (DELETE with a
 * quantity, so a manually merged qty-2 row loses only what was cancelled).
 * `before(row, take)` is awaited before EACH delete and returns its request id
 * (the caller saves it first, so an interrupted delete is re-sent as the same
 * request); `after(n)` gets the units stock-manager says it took. Throws on a
 * failed delete. Mutates `rows` (removed quantities come off) and returns
 * units removed.
 */
async function removeUnits(rows, suffix, qty, { before = async () => null, after = async () => {} } = {}) {
  let removed = 0;
  for (const row of rows) {
    if (removed >= qty) break;
    if (row.qty <= 0 || skuSuffix(row.sku) !== suffix) continue;
    const take = Math.min(row.qty, qty - removed);
    const requestId = await before(row, take);
    const took = await cancelQueueRow(row.id, take, requestId);
    row.qty = took ? row.qty - took : 0;
    removed += took;
    await after(took);
  }
  return removed;
}

/**
 * The part of a cancelled line that wasn't in the queue had already been
 * marked shipped — stock-manager's /api/pending/unship-cancelled puts that
 * stock back (and remembers it, so a later return scan of the same parcel
 * doesn't add it again). `requestId` makes a retry safe: stock-manager
 * answers a repeat of the same request with what it already reversed instead
 * of reversing more (a call that timed out after it went through).
 * Returns { reversed, remaining }; throws when stock-manager can't be reached
 * or fails (retry, never "unresolved").
 */
async function unshipLine({ orderId, sku, qty, altOrderIds = [], requestId }) {
  let res;
  try {
    res = await axios.post(
      `${STOCK_MANAGER_URL}/api/pending/unship-cancelled`,
      { orderId: String(orderId), sku, qty, ...(altOrderIds.length ? { altOrderIds } : {}), ...(requestId ? { requestId } : {}) },
      { headers: authHeaders(), timeout: TIMEOUT_MS }
    );
  } catch (err) {
    // stock-manager answered but refused (e.g. reversing would push stock
    // negative) — nothing to retry, a person has to look. A 5xx is its own
    // failure (database down) and is retried like no answer at all.
    const status = err.response && err.response.status;
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return { reversed: 0, remaining: qty, error: (err.response.data && err.response.data.error) || `HTTP ${status}` };
    }
    throw err;
  }
  const data = res.data || {};
  // Not capped at `qty`: a repeat of a request that already put back more than
  // this call asks for must count all of it, or the rest would be un-shipped
  // again under a new request id.
  const reversed = Math.max(0, Number(data.reversedQty) || 0);
  return { reversed, remaining: Math.max(0, qty - reversed), error: data.error || undefined };
}

/**
 * A packed parcel cancelled by hand (the Myntra Cancel page): stock-manager's
 * /api/pending/cancel-packed marks the order's Shipped entry Cancelled and
 * puts the units back in stock — or takes it out of Ready to Ship if it
 * wasn't marked shipped yet. `requestId` makes a retry safe (only what the
 * first try didn't do is done). Returns { cancelled, fromShipped, fromQueue,
 * remaining, alreadyBack }; throws when stock-manager can't be reached or fails.
 */
async function cancelPackedLine({ orderId, sku, qty, trackingId, requestId, note }) {
  const res = await axios.post(
    `${STOCK_MANAGER_URL}/api/pending/cancel-packed`,
    { orderId: String(orderId), sku, qty, requestId, ...(trackingId ? { trackingId } : {}), ...(note ? { note } : {}) },
    { headers: authHeaders(), timeout: TIMEOUT_MS }
  );
  const d = res.data || {};
  const n = (k) => Math.max(0, Number(d[k]) || 0);
  return { cancelled: n('cancelled'), fromShipped: n('fromShipped'), fromQueue: n('fromQueue'), remaining: n('remaining'), alreadyBack: n('alreadyBack') };
}

/**
 * Undo of cancelPackedLine (marked cancelled by mistake): the same request's
 * changes put back. Returns { undone } — or { refused: reason } when
 * stock-manager won't (Myntra has cancelled the order too, or the units were
 * used since); throws on a failure to reach it.
 */
async function undoPackedCancel(requestId) {
  try {
    const res = await axios.post(`${STOCK_MANAGER_URL}/api/pending/cancel-packed/undo`, { requestId }, { headers: authHeaders(), timeout: TIMEOUT_MS });
    return { undone: Math.max(0, Number(res.data && res.data.undone) || 0) };
  } catch (err) {
    const r = err.response;
    if (r && r.status === 409) return { refused: (r.data && r.data.error) || 'stock-manager refused it' };
    throw err;
  }
}

module.exports = { queueRowsForOrder, removeUnits, cancelQueueRow, unshipLine, cancelPackedLine, undoPackedCancel };
