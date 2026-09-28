const { getDb } = require('./db');
const {
  fetchCancelledByProgram,
  pickAmazonImage,
  groupAmazonCancelledItemsBySku,
  formatAmazonCancelAlert,
  formatAmazonCancelHeader,
  formatAmazonItemCaption,
} = require('./amazon');
const { sendTelegramMessage } = require('./telegram');
const { sendPayload } = require('./alertPayload');
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

  return sendPayload({ text: `${header}\n\n${itemCaptions.join('\n\n')}`, photos }, 'amazon');
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

// An order that's still open (unshipped list) but has some lines cancelled —
// only the lines Amazon says were cancelled count (never the whole line).
function partlyCancelledBySuffix(order) {
  const out = {};
  for (const it of order.orderItems || []) {
    const n = Math.min(Number(it.quantityOrdered) || 1, Math.max(0, Number(it.quantityCanceled) || 0));
    if (!n) continue;
    const k = skuSuffix(it.sellerSku);
    if (!out[k]) out[k] = { qty: 0, sku: it.sellerSku, item: it };
    out[k].qty += n;
  }
  return out;
}

// Units of the order still live (ordered minus cancelled), per variant.
function liveBySuffix(order) {
  const out = {};
  for (const it of order.orderItems || []) {
    const ordered = Number(it.quantityOrdered) || 1;
    const live = ordered - Math.min(ordered, Math.max(0, Number(it.quantityCanceled) || 0));
    if (live > 0) out[skuSuffix(it.sellerSku)] = (out[skuSuffix(it.sellerSku)] || 0) + live;
  }
  return out;
}

const signatureOf = (cancelled) => Object.entries(cancelled).map(([k, c]) => `${k}:${c.qty}`).sort().join('|');

const RUN_BUDGET_MS = 50 * 1000;
// Wait for the new-order alert to record what it queued, and while it's being
// sent (see checkCancellations.js).
const ORDER_ALERT_WAIT_MS = 15 * 60 * 1000;
const ORDER_ALERT_LEASE_MS = 5 * 60 * 1000;

/**
 * Runs the shared cancellation engine over `entries` ([{ id, order, cancelledNow }]).
 * `partial`: entries from the unshipped list — only orders whose new-order
 * alert already went out are taken (anything else is the alert's business).
 */
async function sweep(db, entries, { isFirstRun = false, partial = false } = {}) {
  const seenAmazonCancellations = db.collection('seenAmazonCancellations');
  const ids = entries.map((e) => e.id);
  const result = { newCancelCount: 0, alertedCount: 0, removedFromQueue: 0, unshippedQty: 0, unresolvedCount: 0, pending: 0, adopted: 0 };
  if (!ids.length) return result;

  const seenOrderDocs = await db
    .collection('seenAmazonOrders')
    .find({ _id: { $in: ids } })
    .project({ _id: 1, units: 1, alerted: 1, attempts: 1, claimedAt: 1, cancelledWhenShown: 1 })
    .toArray();
  const seenOrderById = new Map(seenOrderDocs.map((d) => [d._id, d]));
  const usable = partial ? entries.filter((e) => { const so = seenOrderById.get(e.id); return so && so.alerted !== false; }) : entries;
  if (!usable.length) return result;

  const existing = await seenAmazonCancellations.find({ _id: { $in: usable.map((e) => e.id) } }).toArray();
  const docById = new Map(existing.map((d) => [d._id, d]));
  const newIds = usable.map((e) => e.id).filter((id) => !docById.has(id));
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

  const started = Date.now();
  for (const { id, order, cancelledNow, liveNow } of usable) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    const sig = signatureOf(cancelledNow);
    const known = docById.get(id);
    const isOld = (known && !('signature' in known) && !known.work) || (!known && isFirstRun);
    if (known && !isOld && known.signature === sig && !known.work) continue;

    const seenOrder = seenOrderById.get(id);
    const alertStillBuilding = seenOrder && 'attempts' in seenOrder && seenOrder.alerted === false && !seenOrder.units;
    // Being sent right now (its claim): wait, so a cancel alert follows it.
    const alertInFlight =
      seenOrder && seenOrder.alerted === false && seenOrder.claimedAt && Date.now() - new Date(seenOrder.claimedAt).getTime() < ORDER_ALERT_LEASE_MS;
    const firstSeen = known && known.seenAt ? new Date(known.seenAt).getTime() : Date.now();
    if (!isOld && (alertInFlight || (alertStillBuilding && Date.now() - firstSeen < ORDER_ALERT_WAIT_MS))) {
      result.pending++;
      continue;
    }

    const doc = await claimCancellation(seenAmazonCancellations, id);
    if (!doc) continue;
    if (isOld) {
      // Learn the baseline — handled the old way already; no alert, no queue change.
      const processed = Object.fromEntries(Object.entries(cancelledNow).map(([k, c]) => [k, c.qty]));
      await seenAmazonCancellations.updateOne({ _id: id }, { $set: { signature: sig, processed, claimedAt: null } });
      result.adopted++;
      continue;
    }

    // Same rules as Myntra (checkCancellations.js): queued by our alert (or an
    // older record from before that bookkeeping), announced only if its
    // new-order alert went out.
    const queuedByUs = !!seenOrder && (!!seenOrder.units || !('attempts' in seenOrder));
    const announce = !!seenOrder && seenOrder.alerted !== false;
    const atAlert = (seenOrder && seenOrder.units) || {};
    const baseline = doc.processed || Object.fromEntries(Object.entries(atAlert).map(([k, u]) => [k, u.cancelledAtAlert || 0]));
    let delivered = false;
    const r = await processCancellation({
      col: seenAmazonCancellations,
      doc,
      orderId: id,
      sig,
      cancelledNow,
      liveNow: liveNow || liveBySuffix(order),
      baseline,
      leftOut: async () => {
        const so = await db.collection('seenAmazonOrders').findOne({ _id: id }, { projection: { cancelledWhenShown: 1 } });
        return (so && so.cancelledWhenShown) || {};
      },
      queuedByUs,
      label: 'Amazon',
      sendAlert: async (units) => {
        // Fresh, after this state was stamped (see checkCancellations.js):
        // being sent right now → announced once it's out.
        const so = await db.collection('seenAmazonOrders').findOne({ _id: id }, { projection: { alerted: 1, claimedAt: 1 } });
        if (so && so.alerted === false && so.claimedAt && Date.now() - new Date(so.claimedAt).getTime() < ORDER_ALERT_LEASE_MS) return { sent: 0 };
        if (!(so ? so.alerted !== false : announce)) return { sent: 1 }; // never alerted as new → no cancel alert either
        const res = await sendAmazonCancelAlert(order, units.map((u) => ({ ...cancelledNow[u.suffix].item, qty: u.qty })));
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
      await noteCancellationFailure(seenAmazonCancellations, doc, id, r.error, 'Amazon', sig);
      result.pending++;
    }
  }
  return result;
}

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

  // Live units = ordered minus what this entry counts as cancelled (a line
  // without a cancelled count is counted as cancelled whole, so it isn't live).
  const entries = [...byId.entries()].map(([id, order]) => {
    const cancelledNow = cancelledBySuffix(order);
    const ordered = {};
    for (const it of order.orderItems || []) ordered[skuSuffix(it.sellerSku)] = (ordered[skuSuffix(it.sellerSku)] || 0) + (Number(it.quantityOrdered) || 1);
    const liveNow = Object.fromEntries(Object.entries(ordered).map(([k, n]) => [k, Math.max(0, n - ((cancelledNow[k] && cancelledNow[k].qty) || 0))]));
    return { id, order, cancelledNow, liveNow };
  });
  const result = await sweep(db, entries, { isFirstRun });
  return { cancelledCount: byId.size, ...result };
}

/**
 * Open (unshipped) orders with a line cancelled — they never show in the
 * cancelled search, which lists whole-order cancellations only. Called by the
 * order check with the list it already fetched: no extra Amazon call.
 */
async function sweepPartlyCancelledAmazonOrders(db, unshippedOrders) {
  const entries = [];
  for (const order of unshippedOrders || []) {
    const cancelledNow = partlyCancelledBySuffix(order);
    if (Object.keys(cancelledNow).length) entries.push({ id: String(order.amazonOrderId), order, cancelledNow });
  }
  return sweep(db, entries, { partial: true });
}

module.exports = { runCheckAmazonCancellations, sweepPartlyCancelledAmazonOrders };
