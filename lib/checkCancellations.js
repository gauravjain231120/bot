const { getDb } = require('./db');
const {
  fetchCancelledOrders,
  fetchOrderItems,
  pickImageUrl,
  formatCancelAlert,
  formatCancelHeader,
  formatItemCaption,
} = require('./myntra');
const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup } = require('./telegram');
const { lookupCategory } = require('./stock');
const { removeCancelledOrdersFromQueue } = require('./pendingQueue');

// Myntra's item-detail endpoint still returns full data (image, size, colour)
// for a cancelled order, same as an open one — so a cancel alert can carry a
// photo and category exactly like a new-order alert, not just plain text.
async function sendCancelAlert(order, headers) {
  let items = [];
  try {
    items = await fetchOrderItems(order.orderId, headers);
  } catch (err) {
    console.error(`Could not fetch item details for cancelled order ${order.orderId}:`, err.message);
  }

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

  if (!isFirstRun) {
    for (const order of newCancellations) {
      await sendCancelAlert(order, headers);
    }
  }

  // A cancelled order still sitting in Ready to Ship would otherwise get
  // packed and shipped for nothing — sweep it out regardless of whether we
  // alerted about it (first-run history included, so the queue starts clean).
  const removedFromQueue = await removeCancelledOrdersFromQueue(newCancellations.map((o) => o.orderId));

  return { cancelledCount: orders.length, newCancelCount: isFirstRun ? 0 : newCancellations.length, removedFromQueue };
}

module.exports = { runCheckCancellations };
