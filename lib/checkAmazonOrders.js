const { getDb } = require('./db');
const {
  fetchUnshippedOrders,
  pickAmazonImage,
  formatAmazonAlert,
  formatAmazonOrderHeader,
  formatAmazonItemCaption,
  groupAmazonItemsBySku,
  amazonOrderDateMs,
  amazonShipByDateMs,
} = require('./amazon');
const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup, replyToChat } = require('./telegram');
const { lookupStock, formatStockLine, lookupCategory } = require('./stock');
const { addToReadyToShip } = require('./readyToShip');
const { recordSessionExpired } = require('./sessionHistory');

// One header per order, then one caption per unique SKU (qty-aggregated) —
// grouped into a single Telegram album when there's more than one, so a
// multi-item order reads as one alert instead of several.
async function sendAmazonOrderAlert(order) {
  const items = groupAmazonItemsBySku(order.orderItems);
  if (items.length === 0) {
    await sendTelegramMessage(formatAmazonAlert(order));
    return;
  }

  // Telegram's media-group album only shows ONE caption inline in the chat
  // (the first photo's) — on mobile the rest are hidden until the album is
  // opened. So every item's SKU/size/stock detail is joined into that single
  // caption alongside the header, instead of spreading one caption per photo.
  const header = formatAmazonOrderHeader(order, items.length);
  const itemCaptions = [];
  const photos = [];

  for (const item of items) {
    const stock = await lookupStock(item.sellerSku);
    const category = await lookupCategory(item.sellerSku);
    // Best-effort — silently skip adding to Ready to Ship on any failure
    // (unmatched SKU, stock-manager hiccup, etc.), never blocks the alert itself.
    await addToReadyToShip({
      sku: item.sellerSku,
      qty: item.qty,
      channel: 'AMAZON',
      orderId: order.amazonOrderId,
      placedAtMs: amazonOrderDateMs(order),
      shipByMs: amazonShipByDateMs(order),
    });
    itemCaptions.push(formatAmazonItemCaption(item, formatStockLine(stock), category));
    const imageUrl = pickAmazonImage(item);
    if (imageUrl) photos.push(imageUrl);
  }

  const combinedCaption = `${header}\n\n${itemCaptions.join('\n\n')}`;

  if (photos.length === 0) {
    await sendTelegramMessage(combinedCaption);
  } else if (photos.length === 1) {
    await sendTelegramPhoto(photos[0], combinedCaption);
  } else {
    await sendTelegramMediaGroup(
      photos.map((photo, i) => ({ photo, caption: i === 0 ? combinedCaption : undefined }))
    );
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
        // Session-expired warnings go only to the primary account, not the
        // full broadcast list — the other recipients don't manage sessions.
        await replyToChat(
          process.env.TELEGRAM_COMMAND_CHAT_ID,
          '⚠️ Amazon session expired. Paste a fresh session on the admin page.'
        );
        await settings.updateOne({ _id: 'status' }, { $set: { amazonSessionExpiredAlertSent: true } }, { upsert: true });
      }
      // Naturally a no-op after the first call for this expiry — nothing left
      // to close once the open history entry has already been marked expired.
      await recordSessionExpired('amazon');
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
