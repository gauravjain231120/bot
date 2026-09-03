const { getDb } = require('./db');
const { fetchCancelledOrders, formatAmazonCancelAlert } = require('./amazon');
const { sendTelegramMessage } = require('./telegram');

async function runCheckAmazonCancellations() {
  const db = await getDb();
  const settings = db.collection('settings');
  const seenAmazonCancellations = db.collection('seenAmazonCancellations');

  const sessionDoc = await settings.findOne({ _id: 'session_amazon' });
  if (!sessionDoc || !sessionDoc.headers) {
    throw new Error('No Amazon session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  // Cancellations can have a large historical backlog (old, already-handled orders).
  // On the very first run ever, seed silently instead of alerting on all of history.
  const isFirstRun = (await seenAmazonCancellations.estimatedDocumentCount()) === 0;

  let orders;
  try {
    orders = await fetchCancelledOrders(headers);
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

  await settings.updateOne(
    { _id: 'status' },
    {
      $set: {
        amazonLastCancelError: '',
        amazonLastCancelCheck: new Date().toISOString(),
        amazonCancelledCount: orders.length,
      },
    },
    { upsert: true }
  );

  const orderIds = orders.map((o) => String(o.amazonOrderId));
  const existing = orderIds.length
    ? await seenAmazonCancellations.find({ _id: { $in: orderIds } }).project({ _id: 1 }).toArray()
    : [];
  const existingIds = new Set(existing.map((d) => d._id));
  const newCancellations = orders.filter((o) => !existingIds.has(String(o.amazonOrderId)));

  if (orderIds.length > 0) {
    await seenAmazonCancellations.bulkWrite(
      orderIds.map((id) => ({
        updateOne: {
          filter: { _id: id },
          update: { $setOnInsert: { _id: id, seenAt: new Date() } },
          upsert: true,
        },
      }))
    );
  }

  let alertedCount = 0;
  if (!isFirstRun && newCancellations.length > 0) {
    // Only alert a cancellation for an order we actually alerted as new
    // ourselves — an order we never saw (a detection gap, or one outside
    // the ~15-most-recent window fetchCancelledOrders/fetchUnshippedOrders
    // ever look at) has no context here and would just read as confusing noise.
    const candidateIds = newCancellations.map((o) => String(o.amazonOrderId));
    const alertedBefore = await db
      .collection('seenAmazonOrders')
      .find({ _id: { $in: candidateIds } })
      .project({ _id: 1 })
      .toArray();
    const alertedIds = new Set(alertedBefore.map((d) => d._id));
    const toAlert = newCancellations.filter((o) => alertedIds.has(String(o.amazonOrderId)));

    for (const order of toAlert) {
      await sendTelegramMessage(formatAmazonCancelAlert(order));
    }
    alertedCount = toAlert.length;
  }

  return { cancelledCount: orders.length, newCancelCount: isFirstRun ? 0 : newCancellations.length, alertedCount };
}

module.exports = { runCheckAmazonCancellations };
