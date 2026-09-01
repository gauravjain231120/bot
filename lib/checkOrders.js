const { getDb } = require('./db');
const {
  fetchOpenOrders,
  fetchOrderItems,
  pickImageUrl,
  formatAlert,
  formatItemCaption,
} = require('./myntra');
const { sendTelegramMessage, sendTelegramPhoto } = require('./telegram');
const { lookupStock, formatStockLine } = require('./stock');
const { addToReadyToShip, formatReadyToShipLine } = require('./readyToShip');

async function sendOrderAlert(order, headers) {
  let items = [];
  try {
    items = await fetchOrderItems(order.orderId, headers);
  } catch (err) {
    console.error(`Could not fetch item details for order ${order.orderId}:`, err.message);
  }

  if (items.length === 0) {
    await sendTelegramMessage(formatAlert(order));
    return;
  }

  for (const item of items) {
    const sku = item.sellerSkuCode || item.skuCode;
    const stock = await lookupStock(sku);
    const rts = await addToReadyToShip({
      sku,
      qty: 1,
      channel: 'MYNTRA',
      orderId: order.orderId,
      placedAtMs: order.orderDate,
      shipByMs: order.packByTime,
    });
    const caption = formatItemCaption(order, item, formatStockLine(stock) + formatReadyToShipLine(rts));
    const imageUrl = pickImageUrl(item);
    if (imageUrl) {
      await sendTelegramPhoto(imageUrl, caption);
    } else {
      await sendTelegramMessage(caption);
    }
  }
}

async function runCheckOrders() {
  const db = await getDb();
  const settings = db.collection('settings');

  const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    throw new Error('No session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  let orders;
  try {
    orders = await fetchOpenOrders(headers);
  } catch (err) {
    const status = err.response && err.response.status;
    await settings.updateOne(
      { _id: 'status' },
      { $set: { lastError: `${new Date().toISOString()} HTTP ${status || ''} ${err.message}` } },
      { upsert: true }
    );
    if (status === 401 || status === 403) {
      const statusDoc = await settings.findOne({ _id: 'status' });
      if (!statusDoc || !statusDoc.sessionExpiredAlertSent) {
        await sendTelegramMessage('⚠️ Myntra session expired. Paste a fresh session on the admin page.');
        await settings.updateOne({ _id: 'status' }, { $set: { sessionExpiredAlertSent: true } }, { upsert: true });
      }
    }
    const wrapped = new Error(`Poll failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    wrapped.status = status;
    throw wrapped;
  }

  await settings.updateOne(
    { _id: 'status' },
    {
      $set: {
        sessionExpiredAlertSent: false,
        lastError: '',
        lastCheck: new Date().toISOString(),
        openCount: orders.length,
      },
    },
    { upsert: true }
  );

  const seenOrders = db.collection('seenOrders');
  const orderIds = orders.map((o) => String(o.orderId));
  const existing = orderIds.length
    ? await seenOrders.find({ _id: { $in: orderIds } }).project({ _id: 1 }).toArray()
    : [];
  const existingIds = new Set(existing.map((d) => d._id));
  const newOrders = orders.filter((o) => !existingIds.has(String(o.orderId)));

  if (orderIds.length > 0) {
    await seenOrders.bulkWrite(
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
    await sendOrderAlert(order, headers);
  }

  return { openCount: orders.length, newCount: newOrders.length };
}

module.exports = { runCheckOrders };
