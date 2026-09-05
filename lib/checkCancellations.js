const { getDb } = require('./db');
const { fetchCancelledOrders, formatCancelAlert } = require('./myntra');
const { sendTelegramMessage } = require('./telegram');
const { removeCancelledOrdersFromQueue } = require('./pendingQueue');

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
      await sendTelegramMessage(formatCancelAlert(order));
    }
  }

  // A cancelled order still sitting in Ready to Ship would otherwise get
  // packed and shipped for nothing — sweep it out regardless of whether we
  // alerted about it (first-run history included, so the queue starts clean).
  const removedFromQueue = await removeCancelledOrdersFromQueue(newCancellations.map((o) => o.orderId));

  return { cancelledCount: orders.length, newCancelCount: isFirstRun ? 0 : newCancellations.length, removedFromQueue };
}

module.exports = { runCheckCancellations };
