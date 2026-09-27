const { getDb } = require('./db');
const {
  fetchCancelledByProgram,
  pickAmazonImage,
  groupAmazonCancelledItemsBySku,
  formatAmazonCancelAlert,
  formatAmazonCancelHeader,
  formatAmazonItemCaption,
} = require('./amazon');
const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup } = require('./telegram');
const { lookupCategory } = require('./stock');
const { skuSuffix } = require('./skuSuffix');
const { claimCancellation, processCancellation, noteCancellationFailure } = require('./cancellationSweep');

// Unlike Myntra, the cancelled-orders search already returns full item detail
// (image, SKU, title) inline — no extra per-order fetch needed for the photo.
// `items` = the cancelled lines to announce. Returns the delivery result.
async function sendAmazonCancelAlert(order, items) {
  if (items.length === 0) return sendTelegramMessage(formatAmazonCancelAlert(order));

  const header = formatAmazonCancelHeader(order, items.reduce((a, i) => a + (i.qty || 1), 0));
  const itemCaptions = [];
  const photos = [];
  for (const item of items) {
    const category = await lookupCategory(item.sellerSku);
    itemCaptions.push(formatAmazonItemCaption(item, '', category));
    const imageUrl = pickAmazonImage(item);
    if (imageUrl) photos.push(imageUrl);
  }

  const combinedCaption = `${header}\n\n${itemCaptions.join('\n\n')}`;
  if (photos.length === 0) return sendTelegramMessage(combinedCaption);
  if (photos.length === 1) return sendTelegramPhoto(photos[0], combinedCaption);
  return sendTelegramMediaGroup(photos.map((photo, i) => ({ photo, caption: i === 0 ? combinedCaption : undefined })));
}

// Cancelled units per variant straight from the search result; the signature
// changes if more of the order is cancelled later.
function cancelledBySuffix(order) {
  const out = {};
  for (const it of groupAmazonCancelledItemsBySku(order.orderItems)) {
    const k = skuSuffix(it.sellerSku);
    if (!out[k]) out[k] = { qty: 0, sku: it.sellerSku, item: it };
    out[k].qty += it.qty;
  }
  return out;
}
const signatureOf = (cancelled) => Object.entries(cancelled).map(([k, c]) => `${k}:${c.qty}`).sort().join('|');

const RUN_BUDGET_MS = 50 * 1000;

async function runCheckAmazonCancellations() {
  const db = await getDb();
  const settings = db.collection('settings');
  const seenAmazonCancellations = db.collection('seenAmazonCancellations');

  const sessionDoc = await settings.findOne({ _id: 'session_amazon' });
  if (!sessionDoc || !sessionDoc.headers) {
    throw new Error('No Amazon session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  // On the very first run ever, seed silently instead of alerting on all of history.
  const isFirstRun = (await seenAmazonCancellations.estimatedDocumentCount()) === 0;

  let orders;
  try {
    orders = Object.values(await fetchCancelledByProgram(headers)).flat();
  } catch (err) {
    const status = err.response && err.response.status;
    await settings.updateOne(
      { _id: 'status' },
      { $set: { amazonLastCancelError: `${new Date().toISOString()} HTTP ${status || ''} ${err.message}` } },
      { upsert: true }
    );
    const wrapped = new Error(`Amazon cancellation poll failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    wrapped.status = status;
    throw wrapped;
  }

  const byId = new Map();
  for (const o of orders) if (!byId.has(String(o.amazonOrderId))) byId.set(String(o.amazonOrderId), o);
  await settings.updateOne(
    { _id: 'status' },
    { $set: { amazonLastCancelError: '', amazonLastCancelCheck: new Date().toISOString(), amazonCancelledCount: byId.size } },
    { upsert: true }
  );

  const ids = [...byId.keys()];
  const existing = ids.length ? await seenAmazonCancellations.find({ _id: { $in: ids } }).toArray() : [];
  const docById = new Map(existing.map((d) => [d._id, d]));
  const newIds = ids.filter((id) => !docById.has(id));
  if (newIds.length) {
    await seenAmazonCancellations.bulkWrite(
      newIds.map((id) => ({
        updateOne: {
          filter: { _id: id },
          update: { $setOnInsert: isFirstRun ? { _id: id, seenAt: new Date() } : { _id: id, seenAt: new Date(), signature: null, processed: null } },
          upsert: true,
        },
      }))
    );
  }

  // Only orders we alerted (and queued) ourselves get the alert and the queue
  // work — one we never saw has no context and would just be noise.
  const seenOrderDocs = ids.length
    ? await db.collection('seenAmazonOrders').find({ _id: { $in: ids } }).project({ _id: 1, units: 1 }).toArray()
    : [];
  const seenOrderById = new Map(seenOrderDocs.map((d) => [d._id, d]));

  const started = Date.now();
  const result = { cancelledCount: byId.size, newCancelCount: 0, alertedCount: 0, removedFromQueue: 0, unshippedQty: 0, unresolvedCount: 0, pending: 0, adopted: 0 };
  for (const id of ids) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    const order = byId.get(id);
    const cancelledNow = cancelledBySuffix(order);
    const sig = signatureOf(cancelledNow);
    const known = docById.get(id);
    const isOld = (known && !('signature' in known) && !known.work) || (!known && isFirstRun);
    if (known && !isOld && known.signature === sig && !known.work) continue;

    const doc = await claimCancellation(seenAmazonCancellations, id);
    if (!doc) continue;
    if (isOld) {
      // Learn the baseline — handled the old way already; no alert, no queue change.
      const processed = Object.fromEntries(Object.entries(cancelledNow).map(([k, c]) => [k, c.qty]));
      await seenAmazonCancellations.updateOne({ _id: id }, { $set: { signature: sig, processed, claimedAt: null } });
      result.adopted++;
      continue;
    }

    const seenOrder = seenOrderById.get(id);
    const atAlert = (seenOrder && seenOrder.units) || {};
    const baseline = doc.processed || Object.fromEntries(Object.entries(atAlert).map(([k, u]) => [k, u.cancelledAtAlert || 0]));
    let delivered = false;
    const r = await processCancellation({
      col: seenAmazonCancellations,
      doc,
      orderId: id,
      sig,
      cancelledNow,
      baseline,
      known: !!seenOrder,
      label: 'Amazon',
      sendAlert: async (newly) => {
        if (!seenOrder) return { sent: 1 }; // never alerted as new → no cancel alert either
        const res = await sendAmazonCancelAlert(order, newly.map((n) => ({ ...cancelledNow[n.suffix].item, qty: n.qty })));
        delivered = res.sent > 0;
        return res;
      },
    });
    if (delivered) result.alertedCount++;
    if (r.done && r.newlyUnits) result.newCancelCount++;
    result.removedFromQueue += r.removed;
    result.unshippedQty += r.unshipped;
    result.unresolvedCount += r.unresolved;
    if (!r.done) {
      await noteCancellationFailure(seenAmazonCancellations, doc, id, r.error, 'Amazon');
      result.pending++;
    }
  }
  return result;
}

module.exports = { runCheckAmazonCancellations };
