const { getDb } = require('./db');
const {
  fetchOpenOrders,
  fetchOrderItems,
  pickImageUrl,
  formatAlert,
  formatOrderHeader,
  formatItemCaption,
} = require('./myntra');
const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup, sendOwnerAlert } = require('./telegram');
const { lookupStock, formatStockLine, lookupCategory } = require('./stock');
const { addToReadyToShip } = require('./readyToShip');
const { myntraShipByDateMs } = require('./dates');
const { recordSessionExpired } = require('./sessionHistory');

// This order is already marked "seen" by the time this runs, so a failure
// here (item-detail fetch, or the Ready-to-Ship add itself) is never retried
// on a later check — it would otherwise vanish from the queue with no record
// anywhere the user actually looks. Goes only to whoever has Owner role, like
// the session-expired alerts, since it needs someone to add the order by hand.
async function alertQueueFailure(orderId, detail) {
  await sendOwnerAlert(
    `⚠️ <b>Myntra order not added to Ready to Ship</b>\nOrder ID: <code>${orderId}</code>\n${detail}\nPlease add it manually.`
  ).catch((err) => console.error('Ready-to-Ship failure alert failed:', err.message));
}

// Telegram caps a media group (album) at 10 photos — an unusually large
// quantity on one line would otherwise silently fail to send.
const MAX_ALBUM_PHOTOS = 10;

// One header per order, then one caption per unique SKU (already qty-aggregated
// by fetchOrderItems) — grouped into a single Telegram album when there's more
// than one, so a multi-item order reads as one alert instead of several. Goes
// to everyone (broadcast list), same as always — only the "not added to
// Ready to Ship" failure alert above is primary-only.
async function sendOrderAlert(order, headers) {
  let items = [];
  try {
    items = await fetchOrderItems(order.orderId, headers);
  } catch (err) {
    console.error(`Could not fetch item details for order ${order.orderId}:`, err.message);
  }

  if (items.length === 0) {
    await sendTelegramMessage(formatAlert(order));
    await alertQueueFailure(order.orderId, 'Could not fetch item details, so nothing could be added.');
    return;
  }

  // Telegram's media-group album only shows ONE caption inline in the chat
  // (the first photo's) — on mobile the rest are hidden until the album is
  // opened. So every item's SKU/size/stock detail is joined into that single
  // caption alongside the header, instead of spreading one caption per photo.
  // The header's own count is total UNITS, not distinct SKU lines — 2 of one
  // item plus 1 of another reads as "3 items", matching the photo count below.
  const totalQty = items.reduce((a, i) => a + (i.qty || 1), 0);
  const header = formatOrderHeader(order, totalQty);
  const itemCaptions = [];
  const photos = [];

  for (const item of items) {
    const sku = item.sellerSkuCode || item.skuCode;
    // Reserve THIS order's stock before reading the stock line, not after —
    // reading it first showed a number that was already stale the instant
    // the reservation below landed a moment later (e.g. "1 left" in the
    // alert while stock-manager's own dashboard, updated by the very next
    // line, already read 0). Reading after addToReadyToShip means the number
    // shown is the true, current one — what stock-manager will show too.
    const added = await addToReadyToShip({
      sku,
      qty: item.qty,
      channel: 'MYNTRA',
      orderId: order.orderId,
      placedAtMs: order.orderDate,
      shipByMs: myntraShipByDateMs(order.orderDate),
    });
    if (!added.ok) {
      await alertQueueFailure(order.orderId, `SKU <code>${sku}</code>: ${added.error}`);
    }
    const stock = await lookupStock(sku);
    const category = await lookupCategory(sku);
    itemCaptions.push(formatItemCaption(item, formatStockLine(stock), category));
    // One photo per physical unit, not one per line — a qty-2 row means two
    // copies of its photo, so the album's photo count is how many pieces to
    // pull off the shelf, not how many distinct products are in the order.
    const imageUrl = pickImageUrl(item);
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
  if (!statusDoc || !statusDoc.sessionExpiredAlertSent) {
    await sendOwnerAlert(message);
    await settings.updateOne({ _id: 'status' }, { $set: { sessionExpiredAlertSent: true } }, { upsert: true });
  }
  // Naturally a no-op after the first call for this expiry — nothing left to
  // close once the open history entry has already been marked expired.
  await recordSessionExpired('myntra');
}

async function runCheckOrders() {
  const db = await getDb();
  const settings = db.collection('settings');

  const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    await settings.updateOne(
      { _id: 'status' },
      { $set: { lastError: `${new Date().toISOString()} No session saved yet` } },
      { upsert: true }
    );
    await alertSessionMissingOrExpired(
      settings,
      '⚠️ Myntra session missing. Paste a fresh session on the admin page (or let the browser extension sync one).'
    );
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
      // Session-expired warnings go only to the primary account, not the
      // full broadcast list — the other recipients don't manage sessions.
      await alertSessionMissingOrExpired(settings, '⚠️ Myntra session expired. Paste a fresh session on the admin page.');
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
