const { getDb } = require('./db');
const {
  fetchCancelledOrders,
  fetchOrderRows,
  groupOrderRows,
  pickImageUrl,
  formatCancelAlert,
  formatCancelHeader,
  formatItemCaption,
} = require('./myntra');
const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup } = require('./telegram');
const { lookupCategory } = require('./stock');
const { forgetMyntraOrderItems } = require('./ordersSnapshot');
const { skuSuffix } = require('./skuSuffix');
const { claimCancellation, processCancellation, noteCancellationFailure } = require('./cancellationSweep');

// Myntra's item-detail endpoint still returns full data (image, size, colour)
// for a cancelled order, same as an open one — so a cancel alert can carry a
// photo and category exactly like a new-order alert, not just plain text.
// `items` = only the units cancelled since last time (never the whole order —
// see PROJECT.md, order 6026100011). Returns the Telegram delivery result.
async function sendCancelAlert(order, items) {
  if (items.length === 0) return sendTelegramMessage(formatCancelAlert(order));

  const header = formatCancelHeader(order, items.reduce((a, i) => a + (i.qty || 1), 0));
  const itemCaptions = [];
  const photos = [];
  for (const item of items) {
    const sku = item.sellerSkuCode || item.skuCode;
    const category = await lookupCategory(sku);
    itemCaptions.push(formatItemCaption(item, '', category));
    const imageUrl = pickImageUrl(item);
    if (imageUrl) photos.push(imageUrl);
  }

  const combinedCaption = `${header}\n\n${itemCaptions.join('\n\n')}`;
  if (photos.length === 0) return sendTelegramMessage(combinedCaption);
  if (photos.length === 1) return sendTelegramPhoto(photos[0], combinedCaption);
  return sendTelegramMediaGroup(photos.map((photo, i) => ({ photo, caption: i === 0 ? combinedCaption : undefined })));
}

// Myntra's cancelled list has no "last changed" field (checked live
// 2026-09-27: orderId, quantity, sellerOrderIds, …). What it does have per
// entry — the cancelled quantity and the seller order-line ids — changes when
// another unit of the same order is cancelled, so that's the signature. An
// order can also appear as more than one entry: they're summed.
function groupCancelList(orders) {
  const byId = new Map();
  for (const o of orders) {
    const id = String(o.orderId);
    const g = byId.get(id) || { order: o, quantity: 0, lineIds: new Set() };
    g.quantity += Number(o.quantity) || 0;
    for (const s of o.sellerOrderIds || []) g.lineIds.add(String(s));
    byId.set(id, g);
  }
  for (const g of byId.values()) g.sig = `${g.quantity}|${[...g.lineIds].sort().join(',')}`;
  return byId;
}

function cancelledBySuffix(rows) {
  const out = {};
  for (const it of groupOrderRows(rows, ['CANCELLED'])) {
    const k = skuSuffix(it.sku);
    if (!out[k]) out[k] = { qty: 0, sku: it.sku, item: it };
    out[k].qty += it.qty;
  }
  return out;
}

// Cancellations are processed until this long into a run; the rest wait for
// the next check.
const RUN_BUDGET_MS = 50 * 1000;
// Old-style records (before per-unit tracking) learn their baseline a few per
// run — one item-detail call each, no alert, no queue change.
const ADOPT_PER_RUN = 10;

async function runCheckCancellations() {
  const db = await getDb();
  const settings = db.collection('settings');
  const seenCancellations = db.collection('seenCancellations');

  const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    throw new Error('No session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  // On the very first run ever, seed silently (as old-style records, which
  // then learn their baseline) instead of alerting on all of history.
  const isFirstRun = (await seenCancellations.estimatedDocumentCount()) === 0;

  let orders;
  try {
    orders = await fetchCancelledOrders(headers);
  } catch (err) {
    const status = err.response && err.response.status;
    await settings.updateOne(
      { _id: 'status' },
      { $set: { lastCancelError: `${new Date().toISOString()} HTTP ${status || ''} ${err.message}` } },
      { upsert: true }
    );
    const wrapped = new Error(`Cancellation poll failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    wrapped.status = status;
    throw wrapped;
  }

  const groups = groupCancelList(orders);
  await settings.updateOne(
    { _id: 'status' },
    { $set: { lastCancelError: '', lastCancelCheck: new Date().toISOString(), cancelledCount: groups.size } },
    { upsert: true }
  );

  const ids = [...groups.keys()];
  const existing = ids.length ? await seenCancellations.find({ _id: { $in: ids } }).toArray() : [];
  const docById = new Map(existing.map((d) => [d._id, d]));
  const newIds = ids.filter((id) => !docById.has(id));
  if (newIds.length) {
    await seenCancellations.bulkWrite(
      newIds.map((id) => ({
        updateOne: {
          filter: { _id: id },
          // First run: old-style (adopted later, silently). Otherwise a new
          // cancellation with no baseline yet.
          update: { $setOnInsert: isFirstRun ? { _id: id, seenAt: new Date() } : { _id: id, seenAt: new Date(), signature: null, processed: null } },
          upsert: true,
        },
      }))
    );
  }
  // A (partly) cancelled order's cached items are now out of date — the
  // dashboard's backfill re-fetches whatever's still open.
  if (newIds.length) await forgetMyntraOrderItems(newIds);

  // Which of these orders we alerted (and so queued) ourselves, and what was
  // already cancelled when we did.
  const seenOrderDocs = ids.length
    ? await db.collection('seenOrders').find({ _id: { $in: ids } }).project({ _id: 1, units: 1 }).toArray()
    : [];
  const seenOrderById = new Map(seenOrderDocs.map((d) => [d._id, d]));

  const started = Date.now();
  const result = { cancelledCount: groups.size, newCancelCount: 0, removedFromQueue: 0, unshippedQty: 0, unresolvedCount: 0, pending: 0, adopted: 0 };
  let adoptions = 0;
  for (const id of ids) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    const g = groups.get(id);
    const known = docById.get(id);
    const isOld = known && !('signature' in known) && !known.work;
    // Fully handled and unchanged → nothing to do (no Myntra call).
    if (known && !isOld && known.signature === g.sig && !known.work) continue;
    if ((isOld || (!known && isFirstRun)) && adoptions >= ADOPT_PER_RUN) continue;

    const doc = await claimCancellation(seenCancellations, id);
    if (!doc) continue;
    let rows;
    try {
      rows = await fetchOrderRows(id, headers);
    } catch (err) {
      // The packers must hear "STOP" even if the detail isn't available yet —
      // a plain alert once; the queue work is retried.
      if (!isOld && !(!known && isFirstRun) && doc.plainAlertedSig !== g.sig) {
        const res = await sendCancelAlert(g.order, []);
        if (res.sent > 0) await seenCancellations.updateOne({ _id: id }, { $set: { plainAlertedSig: g.sig } });
      }
      await noteCancellationFailure(seenCancellations, doc, id, `item details: ${err.message}`, 'Myntra');
      result.pending++;
      continue;
    }
    const cancelledNow = cancelledBySuffix(rows);

    if (isOld || (!known && isFirstRun)) {
      // Learn the baseline: everything cancelled so far was handled the old way.
      const processed = Object.fromEntries(Object.entries(cancelledNow).map(([k, c]) => [k, c.qty]));
      await seenCancellations.updateOne({ _id: id }, { $set: { signature: g.sig, processed, claimedAt: null } });
      adoptions++;
      result.adopted++;
      continue;
    }
    if (Object.keys(cancelledNow).length === 0) {
      // Listed as cancelled but no unit row says so yet (Myntra lag) — retry.
      await noteCancellationFailure(seenCancellations, doc, id, 'no cancelled unit rows yet', 'Myntra');
      result.pending++;
      continue;
    }

    const seenOrder = seenOrderById.get(id);
    const atAlert = (seenOrder && seenOrder.units) || {};
    const baseline = doc.processed || Object.fromEntries(Object.entries(atAlert).map(([k, u]) => [k, u.cancelledAtAlert || 0]));
    const r = await processCancellation({
      col: seenCancellations,
      doc,
      orderId: id,
      sig: g.sig,
      cancelledNow,
      baseline,
      known: !!seenOrder,
      label: 'Myntra',
      sendAlert: (newly) => {
        // A plain "STOP" already went out for this very cancellation (its
        // detail wasn't available then) — don't announce it twice.
        if (doc.plainAlertedSig === g.sig) return { sent: 1 };
        return sendCancelAlert(g.order, newly.map((n) => ({ ...cancelledNow[n.suffix].item, qty: n.qty })));
      },
    });
    if (r.done && r.newlyUnits) result.newCancelCount++;
    result.removedFromQueue += r.removed;
    result.unshippedQty += r.unshipped;
    result.unresolvedCount += r.unresolved;
    if (!r.done) {
      await noteCancellationFailure(seenCancellations, doc, id, r.error, 'Myntra');
      result.pending++;
    }
  }
  return result;
}

module.exports = { runCheckCancellations, groupCancelList };
