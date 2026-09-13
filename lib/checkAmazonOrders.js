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

// This order is already marked "seen" by the time this runs, so a failure
// here (the Ready-to-Ship add itself) is never retried on a later check — it
// would otherwise vanish from the queue with no record anywhere the user
// actually looks. Goes only to the primary chat, like the session-expired
// alerts, since it needs someone to add the order by hand.
async function alertQueueFailure(orderId, detail) {
  await replyToChat(
    process.env.TELEGRAM_COMMAND_CHAT_ID,
    `⚠️ <b>Amazon order not added to Ready to Ship</b>\nOrder ID: <code>${orderId}</code>\n${detail}\nPlease add it manually.`
  ).catch((err) => console.error('Ready-to-Ship failure alert failed:', err.message));
}

// Telegram caps a media group (album) at 10 photos — an unusually large
// quantity on one line would otherwise silently fail to send.
const MAX_ALBUM_PHOTOS = 10;

// One header per order, then one caption per unique SKU (qty-aggregated) —
// grouped into a single Telegram album when there's more than one, so a
// multi-item order reads as one alert instead of several. Goes to everyone
// (broadcast list), same as always — only the "not added to Ready to Ship"
// failure alert above is primary-only.
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
  // The header's own count is total UNITS, not distinct SKU lines — 2 of one
  // item plus 1 of another reads as "3 items", matching the photo count below.
  const totalQty = items.reduce((a, i) => a + (i.qty || 1), 0);
  const header = formatAmazonOrderHeader(order, totalQty);
  const itemCaptions = [];
  const photos = [];

  for (const item of items) {
    const stock = await lookupStock(item.sellerSku);
    const category = await lookupCategory(item.sellerSku);
    // Never blocks the alert itself — but a failure here is otherwise
    // permanent (see alertQueueFailure above), so it must surface somewhere.
    const added = await addToReadyToShip({
      sku: item.sellerSku,
      qty: item.qty,
      channel: 'AMAZON',
      orderId: order.amazonOrderId,
      placedAtMs: amazonOrderDateMs(order),
      shipByMs: amazonShipByDateMs(order),
    });
    if (!added.ok) {
      await alertQueueFailure(order.amazonOrderId, `SKU <code>${item.sellerSku}</code>: ${added.error}`);
    }
    itemCaptions.push(formatAmazonItemCaption(item, formatStockLine(stock), category));
    // One photo per physical unit, not one per line — a qty-2 row means two
    // copies of its photo, so the album's photo count is how many pieces to
    // pull off the shelf, not how many distinct products are in the order.
    const imageUrl = pickAmazonImage(item);
    if (imageUrl) {
      for (let i = 0; i < Math.max(1, item.qty || 1); i++) photos.push(imageUrl);
    }
  }

  const combinedCaption = `${header}\n\n${itemCaptions.join('\n\n')}`;
  const cappedPhotos = photos.slice(0, MAX_ALBUM_PHOTOS);

  if (cappedPhotos.length === 0) {
    await sendTelegramMessage(combinedCaption);
  } else if (cappedPhotos.length === 1) {
    await sendTelegramPhoto(cappedPhotos[0], combinedCaption);
  } else {
    await sendTelegramMediaGroup(
      cappedPhotos.map((photo, i) => ({ photo, caption: i === 0 ? combinedCaption : undefined }))
    );
  }
}

// Shared by "session missing entirely" and "session rejected (401/403)" below —
// previously only the 401/403 path sent this, so a session that vanished from
// the DB outright (rather than merely expiring) failed silently with no
// Telegram warning at all. Same dedup flag either way, so it still only fires
// once per outage, not every minute.
async function alertSessionMissingOrExpired(settings, message) {
  const statusDoc = await settings.findOne({ _id: 'status' });
  if (!statusDoc || !statusDoc.amazonSessionExpiredAlertSent) {
    await replyToChat(process.env.TELEGRAM_COMMAND_CHAT_ID, message);
    await settings.updateOne({ _id: 'status' }, { $set: { amazonSessionExpiredAlertSent: true } }, { upsert: true });
  }
  // Naturally a no-op after the first call for this expiry — nothing left to
  // close once the open history entry has already been marked expired.
  await recordSessionExpired('amazon');
}

async function runCheckAmazonOrders() {
  const db = await getDb();
  const settings = db.collection('settings');

  const sessionDoc = await settings.findOne({ _id: 'session_amazon' });
  if (!sessionDoc || !sessionDoc.headers) {
    await settings.updateOne(
      { _id: 'status' },
      { $set: { amazonLastError: `${new Date().toISOString()} No Amazon session saved yet` } },
      { upsert: true }
    );
    await alertSessionMissingOrExpired(
      settings,
      '⚠️ Amazon session missing. Paste a fresh session on the admin page (or let the browser extension sync one).'
    );
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
      // Session-expired warnings go only to the primary account, not the
      // full broadcast list — the other recipients don't manage sessions.
      await alertSessionMissingOrExpired(settings, '⚠️ Amazon session expired. Paste a fresh session on the admin page.');
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
