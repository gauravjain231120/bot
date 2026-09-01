const { getDb } = require('./db');
const {
  fetchUnshippedOrders,
  pickAmazonImage,
  formatAmazonAlert,
  formatAmazonItemCaption,
  amazonOrderDateMs,
  amazonShipByDateMs,
} = require('./amazon');
const { sendTelegramMessage, sendTelegramPhoto } = require('./telegram');
const { lookupStock, formatStockLine } = require('./stock');
const { addToReadyToShip, formatReadyToShipLine } = require('./readyToShip');

async function sendAmazonOrderAlert(order) {
  const items = order.orderItems || [];
  if (items.length === 0) {
    await sendTelegramMessage(formatAmazonAlert(order));
    return;
  }
  for (const item of items) {
    const stock = await lookupStock(item.sellerSku);
    const rts = await addToReadyToShip({
      sku: item.sellerSku,
      qty: item.quantityOrdered || 1,
      channel: 'AMAZON',
      orderId: order.amazonOrderId,
      placedAtMs: amazonOrderDateMs(order),
      shipByMs: amazonShipByDateMs(order),
    });
    const caption = formatAmazonItemCaption(order, item, formatStockLine(stock) + formatReadyToShipLine(rts));
    const imageUrl = pickAmazonImage(item);
    if (imageUrl) {
      await sendTelegramPhoto(imageUrl, caption);
    } else {
      await sendTelegramMessage(caption);
    }
  }
}

async function runCheckAmazonOrders() {
  const db = await getDb();
  const settings = db.collection('settings');

  const sessionDoc = await settings.findOne({ _id: 'session_amazon' });
  if (!sessionDoc || !sessionDoc.headers) {
    throw new Error('No Amazon session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  let orders;
  try {
    orders = await fetchUnshippedOrders(headers);
  } catch (err) {
    const status = err.response && err.response.status;
    await settings.updateOne(
      { _id: 'status' },
      { $set: { amazonLastError: `${new Date().toISOString()} HTTP ${status || ''} ${err.message}` } },
      { upsert: true }
    );
    if (status === 401 || status === 403) {
      const statusDoc = await settings.findOne({ _id: 'status' });
      if (!statusDoc || !statusDoc.amazonSessionExpiredAlertSent) {
        await sendTelegramMessage('⚠️ Amazon session expired. Paste a fresh session on the admin page.');
        await settings.updateOne({ _id: 'status' }, { $set: { amazonSessionExpiredAlertSent: true } }, { upsert: true });
      }
    }
    const wrapped = new Error(`Amazon poll failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    wrapped.status = status;
    throw wrapped;
  }

  await settings.updateOne(
    { _id: 'status' },
    {
      $set: {
        amazonSessionExpiredAlertSent: false,
        amazonLastError: '',
        amazonLastCheck: new Date().toISOString(),
        amazonOpenCount: orders.length,
      },
    },
    { upsert: true }
  );

  const seenAmazonOrders = db.collection('seenAmazonOrders');
  const orderIds = orders.map((o) => String(o.amazonOrderId));
  const existing = orderIds.length
    ? await seenAmazonOrders.find({ _id: { $in: orderIds } }).project({ _id: 1 }).toArray()
    : [];
  const existingIds = new Set(existing.map((d) => d._id));
  const newOrders = orders.filter((o) => !existingIds.has(String(o.amazonOrderId)));

  if (orderIds.length > 0) {
    await seenAmazonOrders.bulkWrite(
      orderIds.map((id) => ({
        updateOne: {
          filter: { _id: id },
          update: { $setOnInsert: { _id: id, seenAt: new Date() } },
          upsert: true,
        },
      }))
    );
  }

  for (const order of newOrders) {
    await sendAmazonOrderAlert(order);
  }

  return { openCount: orders.length, newCount: newOrders.length };
}

module.exports = { runCheckAmazonOrders };
