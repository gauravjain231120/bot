const { getDb } = require('./db');
const {
  fetchCancelledOrders,
  fetchOrderItems,
  pickImageUrl,
  formatCancelAlert,
  formatCancelHeader,
  formatItemCaption,
} = require('./myntra');
const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup, sendOwnerAlert } = require('./telegram');
const { lookupCategory } = require('./stock');
const { removeCancelledOrdersFromQueue, removeCancelledLinesFromQueue, unshipCancelledLines } = require('./pendingQueue');
const { forgetMyntraOrderItems } = require('./ordersSnapshot');
const { escapeHtml } = require('./html');

// Myntra's item-detail endpoint still returns full data (image, size, colour)
// for a cancelled order, same as an open one — so a cancel alert can carry a
// photo and category exactly like a new-order alert, not just plain text.
//
// `items` is pre-fetched by the caller (runCheckCancellations), already
// filtered to just the rows Myntra marked CANCELLED — a multi-item order can
// have some lines cancelled and others still shipping, and this must only
// ever describe the cancelled ones, never the whole order (see PROJECT.md
// for the order 6026100011 incident this fixed).
async function sendCancelAlert(order, items) {
  if (items.length === 0) {
    await sendTelegramMessage(formatCancelAlert(order));
    return;
  }

  const header = formatCancelHeader(order, items.length);
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
  if (photos.length === 0) {
    await sendTelegramMessage(combinedCaption);
  } else if (photos.length === 1) {
    await sendTelegramPhoto(photos[0], combinedCaption);
  } else {
    await sendTelegramMediaGroup(photos.map((photo, i) => ({ photo, caption: i === 0 ? combinedCaption : undefined })));
  }
}

async function runCheckCancellations() {
  const db = await getDb();
  const settings = db.collection('settings');
  const seenCancellations = db.collection('seenCancellations');

  const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    throw new Error('No session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  // Cancellations can have a large historical backlog (old, already-handled orders).
  // On the very first run ever, seed silently instead of alerting on all of history.
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

  await settings.updateOne(
    { _id: 'status' },
    {
      $set: {
        lastCancelError: '',
        lastCancelCheck: new Date().toISOString(),
        cancelledCount: orders.length,
      },
    },
    { upsert: true }
  );

  const orderIds = orders.map((o) => String(o.orderId));
  const existing = orderIds.length
    ? await seenCancellations.find({ _id: { $in: orderIds } }).project({ _id: 1 }).toArray()
    : [];
  const existingIds = new Set(existing.map((d) => d._id));
  const newCancellations = orders.filter((o) => !existingIds.has(String(o.orderId)));

  if (orderIds.length > 0) {
    await seenCancellations.bulkWrite(
      orderIds.map((id) => ({
        updateOne: {
          filter: { _id: id },
          update: { $setOnInsert: { _id: id, seenAt: new Date() } },
          upsert: true,
        },
      }))
    );
  }

  // Fetch each newly-cancelled order's item detail ONCE, filtered to just the
  // rows Myntra actually marked CANCELLED — used for both the alert (unless
  // this is the historical first-run seed) and for trimming exactly those
  // cancelled lines out of Ready to Ship below, never the whole order. Orders
  // whose fetch fails fall back to the old whole-order removal, since there's
  // no better information available for them.
  // A (partly) cancelled order's cached items are now out of date — the
  // dashboard's backfill re-fetches whatever's still open.
  await forgetMyntraOrderItems(newCancellations.map((o) => o.orderId));

  const cancelledLines = [];
  const fetchFailedOrderIds = [];
  for (const order of newCancellations) {
    let items;
    try {
      items = await fetchOrderItems(order.orderId, headers, ['CANCELLED']);
    } catch (err) {
      console.error(`Could not fetch item details for cancelled order ${order.orderId}:`, err.message);
      fetchFailedOrderIds.push(order.orderId);
      if (!isFirstRun) await sendTelegramMessage(formatCancelAlert(order));
      continue;
    }

    if (!isFirstRun) await sendCancelAlert(order, items);
    for (const item of items) {
      const sku = item.sellerSkuCode || item.skuCode;
      if (sku) cancelledLines.push({ orderId: order.orderId, sku, qty: item.qty });
    }
  }

  // A cancelled line still sitting in Ready to Ship would otherwise get
  // packed and shipped for nothing — sweep it out regardless of whether we
  // alerted about it (first-run history included, so the queue starts clean).
  // Precise per-line removal for orders whose item detail we actually have;
  // whole-order fallback only for the (rare) ones whose fetch failed above.
  const { removed: removedFromQueue, shortfalls } = await removeCancelledLinesFromQueue(cancelledLines);
  const removedWholeOrders = await removeCancelledOrdersFromQueue(fetchFailedOrderIds);

  // Whatever wasn't (fully) in the queue was already shipped before the
  // cancellation was seen — presumed RTO, so restore that stock instead
  // (never re-queued: there's no live order left to ship it to).
  const { reversed: unshippedQty, unresolved } = await unshipCancelledLines(shortfalls);

  // Neither in the queue nor fully reversible in Shipped — something doesn't
  // add up (e.g. already returned/adjusted by hand) and needs a human look,
  // same as an order that failed to queue in the first place.
  const seenOrders = db.collection('seenOrders');
  const unresolvedOrderIds = [...new Set(unresolved.map((l) => String(l.orderId)))];
  const knownUnresolved = unresolvedOrderIds.length > 0
    ? await seenOrders.find({ _id: { $in: unresolvedOrderIds } }).project({ _id: 1 }).toArray()
    : [];
  const knownUnresolvedIds = new Set(knownUnresolved.map((d) => d._id));

  for (const line of unresolved) {
    // If the bot never actually saw this order as open in the first place
    // (a "ghost order" cancelled before the 2-minute polling cycle could catch it),
    // it was never added to stock-manager. So there is nothing to reverse.
    // Silently ignore this phantom shortfall instead of alerting the owner.
    if (!knownUnresolvedIds.has(String(line.orderId))) {
      console.log(`Silently ignoring unresolved cancellation for unseen ghost order ${line.orderId}`);
      continue;
    }

    await sendOwnerAlert(
      `⚠️ <b>Cancelled line not fully found</b>\nOrder ID: <code>${escapeHtml(line.orderId)}</code>\nSKU: <code>${escapeHtml(line.sku)}</code>\n` +
        `${line.qty} unit(s) cancelled but not in Ready to Ship or fully reversible in Shipped — please check stock manually.`
    ).catch((err) => console.error('Unresolved-cancellation alert failed:', err.message));
  }

  return {
    cancelledCount: orders.length,
    newCancelCount: isFirstRun ? 0 : newCancellations.length,
    removedFromQueue: removedFromQueue + removedWholeOrders,
    unshippedQty,
    unresolvedCount: unresolved.length,
  };
}

module.exports = { runCheckCancellations };
