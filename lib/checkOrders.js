const { getDb } = require('./db');
const {
  fetchOpenOrders,
  fetchOrderItems,
  pickImageUrl,
  formatAlert,
  formatOrderHeader,
  formatItemCaption,
} = require('./myntra');
const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup } = require('./telegram');
const { lookupStock, formatStockLine } = require('./stock');
const { addToReadyToShip } = require('./readyToShip');
const { myntraShipByDateMs } = require('./dates');

// One header per order, then one caption per unique SKU (already qty-aggregated
// by fetchOrderItems) — grouped into a single Telegram album when there's more
// than one, so a multi-item order reads as one alert instead of several.
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

  // The header (Order ID/Placed/Ship by/MULTI ORDER) is folded into the FIRST
  // item's caption rather than sent as its own message — two separate
  // sendMessage/sendPhoto calls always render as two separate chat bubbles,
  // even sent back to back, which read as unrelated alerts.
  const header = formatOrderHeader(order, items.length);
  const media = [];
  const textOnly = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const sku = item.sellerSkuCode || item.skuCode;
    const stock = await lookupStock(sku);
    // Best-effort — silently skip adding to Ready to Ship on any failure
    // (unmatched SKU, stock-manager hiccup, etc.), never blocks the alert itself.
    await addToReadyToShip({
      sku,
      qty: item.qty,
      channel: 'MYNTRA',
      orderId: order.orderId,
      placedAtMs: order.orderDate,
      shipByMs: myntraShipByDateMs(order.orderDate),
    });
    const itemCaption = formatItemCaption(item, formatStockLine(stock));
    const caption = i === 0 ? `${header}\n\n${itemCaption}` : itemCaption;
    const imageUrl = pickImageUrl(item);
    if (imageUrl) media.push({ photo: imageUrl, caption });
    else textOnly.push(caption);
  }

  if (media.length === 1) {
    await sendTelegramPhoto(media[0].photo, media[0].caption);
  } else if (media.length > 1) {
    await sendTelegramMediaGroup(media);
  }
  for (const text of textOnly) {
    await sendTelegramMessage(text);
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
