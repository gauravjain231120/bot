const { getDb } = require('./db');
const { lookupPackedShipment, fetchOrderRows, isSessionRejected } = require('./myntra');
const { cancelPackedLine, undoPackedCancel } = require('./pendingQueue');
const { skuSuffix } = require('./skuSuffix');
const { myntraOrdersWithSku } = require('./stock');

// The Myntra Cancel page (app/myntra-cancel): a packed parcel that won't go
// out — the courier refused it at pickup, or the order was cancelled after
// packing and Myntra's lists don't say so (yet). Scanning it here:
//   - saves its tracking id (collection `manualCancels`, _id = tracking id),
//     so it's left out of every packed count — the OTC message and the
//     Overview "Myntra packed" card (they only look 4 days back);
//   - finds its order and tells stock-manager (cancelPackedLine): the Shipped
//     entry is marked Cancelled and the units go back in stock, or, still in
//     Ready to Ship, it's taken out of the queue.
// Myntra's own cancellation arriving later never counts it twice
// (stock-manager's unshipCancelledLine counts the hand-cancelled units).
//
// Which order: Myntra's packet answer has no order id and the label shows
// none, but each order line carries the moment it was packed — the same
// moment as the parcel's packedOn (checked live 2026-09-28: 2 s apart, while
// another order of the same SKU was 2½ days off). So: orders with this
// product around the packing time — from the bot's own order records (their
// units, their cached items) and stock-manager's (shipped, queued, cancelled)
// — each one's rows read
// (one Myntra call each, only when a parcel is scanned here), and the one
// packed at the parcel's time wins. Most recent orders first, 3 at a time,
// stopping one batch after a match — usually 1–2 batches.

const COL = 'manualCancels';
const PREVIEWS = 'manualCancelPreviews';
const DAY_MS = 24 * 60 * 60 * 1000;
// Removing an entry would put its parcel back in the packed counts — only
// once it's older than the 4 days those look at.
const DELETE_AFTER_MS = 4 * DAY_MS;
// Myntra wants an order packed within a day or two of it being placed.
const MATCH_LOOKBACK_MS = 5 * DAY_MS;
const MATCH_TOLERANCE_MS = 3 * 60 * 1000;
// An order the person may pick by hand (the match wasn't sure): packed within
// this long of the parcel — anything further off isn't it. Same on the page.
const PICK_WINDOW_SEC = 30 * 60;
const MAX_CANDIDATES = 12;
// What a scan found is kept this long for the "Mark cancelled" press — no
// second round of Myntra calls, and nothing the browser sends is trusted.
const PREVIEW_TTL_MS = 30 * 60 * 1000;

const cleanId = (raw) => String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const errText = (err) => (err && err.response && err.response.data && err.response.data.error) || (err && err.message) || String(err);

// One order's line for this product, packed when? (Myntra's order rows carry
// packedOn; lastModifiedOn is the packing moment too while it's PACKED.)
function rowPackedMs(row) {
  return Number(row.packedOn) || Date.parse(row.packedOn) || Number(row.lastModifiedOn) || null;
}

/**
 * The order a packet belongs to: { orderId, sure, candidates, reason? }.
 * `candidates` — every order looked at, closest packing time first:
 * [{ orderId, deltaSec, status }] (deltaSec null: no line of this product,
 * or its rows couldn't be read).
 */
async function findOrder(packet, headers, db) {
  const packedOn = packet.packedOn && packet.packedOn.ms;
  const suffixes = [...new Set((packet.items || []).map((it) => skuSuffix(it.sellerSkuCode)).filter(Boolean))];
  if (!packedOn || suffixes.length === 0) {
    return { orderId: null, sure: false, candidates: [], reason: "Myntra didn't say when this parcel was packed or what's in it." };
  }
  const seen = await candidateOrders(packet, suffixes[0], packedOn, db);
  if (seen.length === 0) {
    return { orderId: null, sure: false, candidates: [], reason: 'No Myntra order with this product in the 5 days before it was packed.' };
  }

  const candidates = [];
  let unreadable = 0;
  const isClose = (c) => c.deltaSec != null && c.deltaSec * 1000 <= MATCH_TOLERANCE_MS;
  // One more batch is read after the first match: another order of this
  // product packed seconds apart would be just as recent.
  let batchesAfterMatch = null;
  for (let i = 0; i < seen.length; i += 3) {
    if (batchesAfterMatch === 0) break;
    const batch = await Promise.all(
      seen.slice(i, i + 3).map(async ({ _id }) => {
        const orderId = String(_id);
        try {
          const rows = await fetchOrderRows(orderId, headers);
          const mine = rows.filter((r) => suffixes.includes(skuSuffix(r.sellerSkuCode || r.skuCode)));
          let best = null;
          for (const r of mine) {
            const at = rowPackedMs(r);
            if (!at) continue;
            const delta = Math.abs(at - packedOn);
            if (!best || delta < best.delta) best = { delta, status: r.status || null };
          }
          return { orderId, deltaSec: best ? Math.round(best.delta / 1000) : null, status: best ? best.status : null };
        } catch (err) {
          // A rejected session is the page's problem to report, not "no match".
          if (isSessionRejected(err)) throw err;
          unreadable++;
          return { orderId, deltaSec: null, status: null, error: err.message };
        }
      })
    );
    candidates.push(...batch);
    if (batchesAfterMatch !== null) batchesAfterMatch--;
    else if (batch.some(isClose)) batchesAfterMatch = 1;
  }
  candidates.sort((a, b) => (a.deltaSec ?? Infinity) - (b.deltaSec ?? Infinity));
  const close = candidates.filter(isClose);
  if (close.length === 0) {
    return {
      orderId: null,
      sure: false,
      candidates,
      reason: unreadable
        ? `Couldn't read ${unreadable} of the orders from Myntra — scan again in a moment.`
        : 'None of the orders with this product was packed at this parcel\'s time.',
    };
  }
  // Two of the same product packed within seconds of each other: the closest
  // is taken, but shown as "not sure" so the person can pick the other.
  const sure = close.length === 1 || close[1].deltaSec - close[0].deltaSec >= 30;
  return { orderId: close[0].orderId, sure, candidates };
}

// Orders that could be the parcel's, closest to its packing time first (at
// most MAX_CANDIDATES): [{ _id }]. The bot's order records only list a
// product's units since 2026-09-28, and its item cache keeps ~5 days — so
// stock-manager's entries are asked too (read-only; skipped if unreachable).
async function candidateOrders(packet, suffix, packedOn, db) {
  const from = packedOn - MATCH_LOOKBACK_MS;
  const upTo = new Date(packedOn + 60 * 60 * 1000); // an order is seen before it's packed
  const sku = (packet.items || []).map((it) => it.sellerSkuCode).find((s) => skuSuffix(s) === suffix);
  const rawSuffix = String(sku || '').slice(String(sku || '').indexOf('-') + 1).trim();
  const skuRe = new RegExp(`-${rawSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const [units, cached, stock] = await Promise.all([
    db.collection('seenOrders').find({ [`units.${suffix}`]: { $exists: true }, seenAt: { $gte: new Date(from), $lte: upTo } }, { projection: { seenAt: 1 } }).limit(100).toArray(),
    db.collection('myntraOrderItems').find({ 'items.sellerSkuCode': skuRe, fetchedAt: { $gte: new Date(from), $lte: upTo } }, { projection: { fetchedAt: 1 } }).limit(100).toArray(),
    // Shipped entries are dated their ship-by day, after packing.
    myntraOrdersWithSku(sku, from, packedOn + MATCH_LOOKBACK_MS).catch((err) => {
      console.error('Myntra Cancel: stock-manager lookup failed —', err.message);
      return [];
    }),
  ]);
  const at = new Map();
  const add = (orderId, t) => {
    if (!orderId) return;
    const d = t == null ? Infinity : Math.abs(t - packedOn);
    if (!at.has(orderId) || d < at.get(orderId)) at.set(orderId, d);
  };
  for (const d of units) add(String(d._id), new Date(d.seenAt).getTime());
  for (const d of cached) add(String(d._id), new Date(d.fetchedAt).getTime());
  for (const d of stock) add(d.orderId, d.at);
  return [...at.entries()].sort((a, b) => a[1] - b[1]).slice(0, MAX_CANDIDATES).map(([_id]) => ({ _id }));
}

/** Units per product in the parcel: [{ suffix, sku, qty }]. */
function linesOf(items) {
  const bySuffix = new Map();
  for (const it of items || []) {
    const suffix = skuSuffix(it.sellerSkuCode);
    if (!suffix) continue;
    const e = bySuffix.get(suffix) || { suffix, sku: it.sellerSkuCode, qty: 0 };
    e.qty += Math.max(1, Number(it.quantity) || 1);
    bySuffix.set(suffix, e);
  }
  return [...bySuffix.values()];
}

// What happened to one product's stock, in words (shown on the page).
function lineText(line, orderId) {
  if (line.state === 'FAILED') return `Couldn't reach stock-manager (${line.error}) — press Retry.`;
  if (line.state === 'UNDONE') return 'undone — back as it was';
  const parts = [];
  if (line.fromShipped) parts.push(`${line.fromShipped} back in stock — its Shipped entry is now Cancelled`);
  if (line.fromQueue) parts.push(`${line.fromQueue} taken out of Ready to Ship (never shipped)`);
  if (line.remaining > 0) {
    parts.push(
      line.alreadyBack > 0
        ? `${line.remaining} already put back when Myntra cancelled the order`
        : `${line.remaining} not found in Ready to Ship or Shipped for order ${orderId} — nothing changed; check stock by hand if needed`
    );
  }
  return parts.join('; ') || 'Nothing to change';
}

function stockSummary(entry) {
  if (!entry.orderId) return [{ tone: 'warn', text: "Order not found, so stock wasn't changed — fix it by hand in stock-manager if needed." }];
  const lines = (entry.stock && entry.stock.lines) || [];
  if (lines.length === 0) return [{ tone: 'warn', text: 'Stock not updated yet — press Retry.' }];
  return lines.map((l) => ({
    tone: l.state === 'FAILED' ? 'bad' : l.remaining > 0 && !l.alreadyBack ? 'warn' : 'good',
    text: `${l.sku} × ${l.qty}: ${lineText(l, entry.orderId)}`,
  }));
}

/** An entry as the page gets it. */
function publicEntry(e, now = Date.now()) {
  const deletableAt = new Date(new Date(e.markedAt).getTime() + DELETE_AFTER_MS);
  return {
    trackingNumber: e._id,
    storePacketId: e.storePacketId || null,
    myntraStatus: e.myntraStatus || null,
    packedOn: e.packedOn || null,
    items: e.items || [],
    orderId: e.orderId || null,
    matchedBy: e.matchedBy || null,
    markedAt: e.markedAt,
    markedBy: e.markedBy || null,
    stockState: (e.stock && e.stock.state) || null,
    summary: stockSummary(e),
    deletableAt,
    canDelete: now >= deletableAt.getTime(),
    undoError: e.undoError || null,
  };
}

async function listManualCancels() {
  const db = await getDb();
  const docs = await db.collection(COL).find({}).sort({ markedAt: -1 }).toArray();
  return docs.map((d) => publicEntry(d));
}

/** Every tracking id marked cancelled here — left out of the packed counts. */
async function cancelledTrackingIds() {
  const db = await getDb();
  const docs = await db.collection(COL).find({}, { projection: { _id: 1 } }).toArray();
  return new Set(docs.map((d) => String(d._id)));
}

// The Overview card's 10-min cache would still count a parcel just marked
// (or un-marked) — dropped, so the next page open counts afresh.
async function clearPackedCache(db) {
  await db.collection('settings').deleteOne({ _id: 'packed_waiting_cache' }).catch(() => {});
}

/**
 * A scan on the page: the parcel and its order, or `already` when it's
 * marked here (no Myntra call then). { notFound } when Myntra has no packed
 * parcel by that id.
 */
async function lookupForCancel(rawId, headers) {
  const id = cleanId(rawId);
  if (!id) return { notFound: true };
  const db = await getDb();
  const marked = await db.collection(COL).findOne({ _id: id });
  if (marked) return { already: publicEntry(marked) };
  const packet = await lookupPackedShipment(id, headers);
  if (!packet) return { notFound: true };
  const key = cleanId(packet.trackingNumber) || id;
  if (key !== id) {
    const byTracking = await db.collection(COL).findOne({ _id: key });
    if (byTracking) return { already: publicEntry(byTracking) };
  }
  const match = await findOrder(packet, headers, db);
  // Already on Myntra's cancelled list: the bot's own cancel check handles it
  // too (nothing is counted twice) — said on the page.
  match.myntraCancelled = match.orderId
    ? !!(await db.collection('seenCancellations').findOne({ _id: String(match.orderId) }, { projection: { _id: 1 } }))
    : false;
  await db.collection(PREVIEWS).updateOne({ _id: key }, { $set: { packet, match, at: new Date() } }, { upsert: true });
  await db.collection(PREVIEWS).deleteMany({ at: { $lt: new Date(Date.now() - DAY_MS) } }).catch(() => {});
  return { trackingNumber: key, packet, match };
}

// Tells stock-manager, line by line; each line's request id is stable, so a
// Retry (or a repeat) only does what earlier tries didn't.
async function applyStock(col, entry) {
  const lines = [];
  for (const l of linesOf(entry.items)) {
    const requestId = `mcancel:${entry._id}:${l.suffix}`;
    try {
      const r = await cancelPackedLine({
        orderId: entry.orderId,
        sku: l.sku,
        qty: l.qty,
        trackingId: entry._id,
        requestId,
        note: `Myntra Cancel scan by ${entry.markedBy || 'someone'}`,
      });
      lines.push({ ...l, requestId, state: 'DONE', ...r });
    } catch (err) {
      lines.push({ ...l, requestId, state: 'FAILED', error: errText(err).slice(0, 200) });
    }
  }
  const stock = { state: lines.every((x) => x.state === 'DONE') ? 'DONE' : 'FAILED', lines, at: new Date() };
  await col.updateOne({ _id: entry._id }, { $set: { stock } });
  return { ...entry, stock };
}

/**
 * "Mark cancelled": saves the parcel (out of the counts from now on) and
 * updates stock. `orderId` — the person's pick when the match wasn't sure
 * (must be one of the orders the scan looked at). Returns { entry, already? }.
 */
async function markCancelled({ trackingNumber, orderId = null, by, headers }) {
  const key = cleanId(trackingNumber);
  if (!key) throw new Error('Scan or type a tracking number');
  const db = await getDb();
  const col = db.collection(COL);
  const existing = await col.findOne({ _id: key });
  if (existing) return { entry: publicEntry(existing), already: true };

  let prev = await db.collection(PREVIEWS).findOne({ _id: key });
  if (!prev || Date.now() - new Date(prev.at).getTime() > PREVIEW_TTL_MS) {
    const fresh = await lookupForCancel(key, headers);
    if (fresh.already) return { entry: fresh.already, already: true };
    if (fresh.notFound) throw Object.assign(new Error(`No packed shipment found for ${key}.`), { status: 404 });
    prev = fresh;
  }
  const { packet, match } = prev;
  let chosen = match.orderId || null;
  if (orderId && String(orderId) !== chosen) {
    if (!(match.candidates || []).some((c) => c.orderId === String(orderId) && c.deltaSec != null && c.deltaSec <= PICK_WINDOW_SEC)) {
      throw Object.assign(new Error("That order isn't one this parcel could be — scan it again."), { status: 400 });
    }
    chosen = String(orderId);
  }

  const entry = {
    _id: key,
    storePacketId: packet.storePacketId || null,
    myntraStatus: packet.status || null,
    packedOn: packet.packedOn ? packet.packedOn.ms : null,
    items: (packet.items || []).map((it) => ({
      sku: it.sellerSkuCode || null,
      sellerSkuCode: it.sellerSkuCode || null,
      productName: it.productName || null,
      size: it.size || null,
      color: it.color || null,
      quantity: it.quantity || 1,
      image: it.image || null,
    })),
    orderId: chosen,
    matchedBy: chosen ? (chosen === match.orderId ? (match.sure ? 'packing time' : 'closest packing time') : 'picked by hand') : null,
    markedAt: new Date(),
    markedBy: by || null,
    stock: chosen ? { state: 'PENDING', lines: [] } : { state: 'NO_ORDER', lines: [] },
  };
  try {
    await col.insertOne(entry);
  } catch (err) {
    if (err && err.code === 11000) return { entry: publicEntry(await col.findOne({ _id: key })), already: true }; // marked meanwhile
    throw err;
  }
  await db.collection(PREVIEWS).deleteOne({ _id: key }).catch(() => {});
  await clearPackedCache(db);
  const done = chosen ? await applyStock(col, entry) : entry;
  return { entry: publicEntry(done) };
}

/** Stock-manager couldn't be reached when it was marked: try the same requests again. */
async function retryStock(trackingNumber) {
  const db = await getDb();
  const col = db.collection(COL);
  const entry = await col.findOne({ _id: cleanId(trackingNumber) });
  if (!entry) throw Object.assign(new Error('Not on the list'), { status: 404 });
  if (!entry.orderId) return { entry: publicEntry(entry) };
  return { entry: publicEntry(await applyStock(col, entry)) };
}

/**
 * Marked by mistake: stock-manager puts back what it changed (Shipped again,
 * or back in Ready to Ship), then the parcel is off the list — counted again.
 * { refused: reason } when stock-manager won't (Myntra has cancelled the
 * order too, or the units were used since); the entry stays.
 */
async function undoCancel(trackingNumber) {
  const db = await getDb();
  const col = db.collection(COL);
  const key = cleanId(trackingNumber);
  const entry = await col.findOne({ _id: key });
  if (!entry) return { ok: true };
  const lines = (entry.stock && entry.stock.lines) || [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].requestId || lines[i].state === 'UNDONE') continue;
    const r = await undoPackedCancel(lines[i].requestId);
    if (r.refused) {
      await col.updateOne({ _id: key }, { $set: { undoError: r.refused } });
      return { refused: r.refused };
    }
    // One product of a mixed parcel undone and another refused: the list must
    // show which is which.
    await col.updateOne({ _id: key }, { $set: { [`stock.lines.${i}.state`]: 'UNDONE' } });
  }
  await col.deleteOne({ _id: key });
  await clearPackedCache(db);
  return { ok: true };
}

/** Off the list, stock untouched — only once it's past the 4 days the counts look at. */
async function removeEntry(trackingNumber, now = Date.now()) {
  const db = await getDb();
  const col = db.collection(COL);
  const key = cleanId(trackingNumber);
  const entry = await col.findOne({ _id: key });
  if (!entry) return { ok: true };
  const at = new Date(entry.markedAt).getTime() + DELETE_AFTER_MS;
  if (now < at) return { refused: `It can be removed from ${new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} — until then it still counts in the packed numbers.` };
  await col.deleteOne({ _id: key });
  return { ok: true };
}

module.exports = {
  lookupForCancel,
  markCancelled,
  retryStock,
  undoCancel,
  removeEntry,
  listManualCancels,
  cancelledTrackingIds,
  findOrder,
  linesOf,
  stockSummary,
  DELETE_AFTER_MS,
  PICK_WINDOW_SEC,
};
