const { getDb } = require('./db');
const { noteSessionFailure, sessionOkFields } = require('./sessionAlerts');
const { noteCheckFailure, checkOkFields } = require('./failureStreak');
const {
  fetchOpenOrders,
  fetchOrderRows,
  groupOrderRows,
  pickImageUrl,
  formatAlert,
  formatOrderHeader,
  formatItemCaption,
  isSessionRejected,
  describeMyntraError,
} = require('./myntra');
const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup, sendOwnerAlert } = require('./telegram');
const { lookupStock, formatStockLine, lookupCategory } = require('./stock');
const { addToReadyToShip } = require('./readyToShip');
const { myntraShipByDateMs } = require('./dates');
const { saveMyntraOpenOrders, cacheMyntraOrderItems, backfillMyntraOrderItems } = require('./ordersSnapshot');
const { escapeHtml } = require('./html');
const { skuSuffix } = require('./skuSuffix');
const { recordSeen, pendingAlerts, claimAlert, markAlerted, releaseAlert, MAX_ATTEMPTS } = require('./orderClaims');

// Goes only to whoever has Owner role, like the session-expired alerts, since
// it needs someone to add the order by hand.
async function alertQueueFailure(orderId, detail) {
  await sendOwnerAlert(
    `⚠️ <b>Myntra order not added to Ready to Ship</b>\nOrder ID: <code>${escapeHtml(orderId)}</code>\n${detail}\nPlease add it manually.`
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
//
// Returns { delivered, units, retryLater }:
//   delivered   the alert reached at least one recipient (or there was nothing
//               to alert: every unit already cancelled)
//   units       per SKU suffix: units queued and units ALREADY cancelled when
//               we first looked — the cancel sweep must never "remove" those
//               from Ready to Ship, they were never put there
//   retryLater  item detail couldn't be fetched — try again next check before
//               falling back to a plain alert
async function sendOrderAlert(order, headers, { attempt = 1, openCount = null } = {}) {
  let rows = null;
  try {
    rows = await fetchOrderRows(order.orderId, headers);
  } catch (err) {
    console.error(`Could not fetch item details for order ${order.orderId}:`, err.message);
  }
  if (rows === null && attempt < 2) return { delivered: false, retryLater: true };
  const items = rows ? groupOrderRows(rows, ['CREATED']) : [];
  const cancelledEarly = rows ? groupOrderRows(rows, ['CANCELLED']) : [];
  const units = {};
  for (const it of items) (units[skuSuffix(it.sku)] ||= { queued: 0, cancelledAtAlert: 0 }).queued += it.qty;
  for (const it of cancelledEarly) (units[skuSuffix(it.sku)] ||= { queued: 0, cancelledAtAlert: 0 }).cancelledAtAlert += it.qty;
  // Reused by the dashboard's order grid, so it never has to fetch these itself.
  if (items.length) await cacheMyntraOrderItems(order.orderId, items);

  // Every unit was cancelled before we saw the order (list lag) — nothing to
  // ship, nothing to announce.
  if (rows && rows.length && items.length === 0 && cancelledEarly.length) return { delivered: true, units };

  if (items.length === 0) {
    const res = await sendTelegramMessage(formatAlert(order, openCount));
    await alertQueueFailure(order.orderId, 'Could not fetch item details, so nothing could be added.');
    return { delivered: res.sent > 0, units: null };
  }

  // Telegram's media-group album only shows ONE caption inline in the chat
  // (the first photo's) — on mobile the rest are hidden until the album is
  // opened. So every item's SKU/size/stock detail is joined into that single
  // caption alongside the header, instead of spreading one caption per photo.
  // The header's own count is total UNITS, not distinct SKU lines — 2 of one
  // item plus 1 of another reads as "3 items", matching the photo count below.
  const totalQty = items.reduce((a, i) => a + (i.qty || 1), 0);
  const header = formatOrderHeader(order, totalQty, openCount);
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
      await alertQueueFailure(order.orderId, `SKU <code>${escapeHtml(sku)}</code>: ${escapeHtml(added.error)}`);
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

  let res;
  if (cappedPhotos.length === 0) {
    res = await sendTelegramMessage(combinedCaption);
  } else if (cappedPhotos.length === 1) {
    res = await sendTelegramPhoto(cappedPhotos[0], combinedCaption);
  } else {
    res = await sendTelegramMediaGroup(
      cappedPhotos.map((photo, i) => ({ photo, caption: i === 0 ? combinedCaption : undefined }))
    );
  }
  return { delivered: res.sent > 0, units };
}

// New orders are alerted until this long into a run; the rest wait for the
// next check (2 min later) rather than risk the function being killed with
// alerts half-sent.
const ALERT_BUDGET_MS = 50 * 1000;

async function alertNewOrders(db, orders, headers) {
  const seenOrders = db.collection('seenOrders');
  const byId = new Map(orders.map((o) => [String(o.orderId), o]));
  const ids = [...byId.keys()];
  await recordSeen(seenOrders, ids);
  const pending = await pendingAlerts(seenOrders, ids);
  const started = Date.now();
  let alerted = 0;
  let deferred = 0;
  for (const id of pending) {
    if (Date.now() - started > ALERT_BUDGET_MS) {
      deferred++;
      continue;
    }
    const doc = await claimAlert(seenOrders, id);
    if (!doc) continue; // another run has it, or it's done
    try {
      const res = await sendOrderAlert(byId.get(id), headers, { attempt: doc.attempts, openCount: ids.length });
      // The first look at the order is the baseline for the cancel sweep —
      // never overwritten by a retry.
      const keepUnits = res.units && !doc.units ? { units: res.units } : {};
      if (res.delivered) {
        await markAlerted(seenOrders, id, keepUnits);
        alerted++;
      } else {
        const { gaveUp } = await releaseAlert(seenOrders, id, doc, keepUnits);
        if (gaveUp) await giveUpAlert(id);
      }
    } catch (err) {
      console.error(`New-order alert for ${id} failed:`, err.message);
      const { gaveUp } = await releaseAlert(seenOrders, id, doc);
      if (gaveUp) await giveUpAlert(id);
    }
  }
  return { newCount: alerted, deferred };
}

async function giveUpAlert(orderId) {
  await sendOwnerAlert(
    `⚠️ <b>Myntra order alert could not be sent</b>\nOrder ID: <code>${escapeHtml(orderId)}</code>\n` +
      `Tried ${MAX_ATTEMPTS} times. Check the order on Myntra and that it's in Ready to Ship.`
  ).catch((err) => console.error('give-up alert failed:', err.message));
}

const BLOCKED_ALERT_AFTER = 15;

async function noteMyntraBlocked(settings) {
  try {
    const doc = await settings.findOneAndUpdate(
      { _id: 'status' },
      { $inc: { myntraBlockedStreak: 1 } },
      { upsert: true, returnDocument: 'after', projection: { myntraBlockedStreak: 1, myntraBlockedAlertSent: 1 } }
    );
    if (doc && doc.myntraBlockedStreak >= BLOCKED_ALERT_AFTER && !doc.myntraBlockedAlertSent) {
      const claimed = await settings.findOneAndUpdate({ _id: 'status', myntraBlockedAlertSent: { $ne: true } }, { $set: { myntraBlockedAlertSent: true } }, { returnDocument: 'after' });
      if (!claimed) return;
      const res = await sendOwnerAlert(
        '⚠️ <b>Myntra is blocking the bot\'s requests</b> (bot protection) for ~30 min — new orders are not being checked. The login itself looks fine; it usually clears by itself. If it doesn\'t, open Myntra in Chrome and use it normally for a minute.'
      ).catch(() => ({ sent: 0 }));
      if (res && res.sent === 0) await settings.updateOne({ _id: 'status' }, { $set: { myntraBlockedAlertSent: false } });
    }
  } catch (e) {
    console.error('blocked-streak update failed:', e.message);
  }
}

// True when the stored session is no longer the one this run used.
async function sessionReplaced(settings, sessionId, headers) {
  const now = await settings.findOne({ _id: sessionId }, { projection: { 'headers.cookie': 1 } });
  return !!(now && now.headers && headers && now.headers.cookie !== headers.cookie);
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
    // "Missing" and "expired" share one once-per-outage alert (lib/sessionAlerts.js).
    await noteSessionFailure(
      settings,
      'myntra',
      '⚠️ Myntra session missing. Paste a fresh session on the admin page (or let the browser extension sync one).',
      { sessionDoc: null }
    );
    throw new Error('No session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  let orders;
  try {
    orders = await fetchOpenOrders(headers);
  } catch (err) {
    const status = err.response && err.response.status;
    // A newer session was saved while this check ran (the extension restored
    // it) — this failure belongs to the old copy; recording it would mark the
    // fresh session "expired" again.
    if (await sessionReplaced(settings, 'session', headers)) {
      const stale = new Error(`Poll failed on a session that has since been replaced: ${err.message}`);
      stale.status = status;
      throw stale;
    }
    await settings.updateOne(
      { _id: 'status' },
      { $set: { lastError: `${new Date().toISOString()} ${describeMyntraError(err)}` } },
      { upsert: true }
    );
    if (!err.blocked && !isSessionRejected(err)) await noteCheckFailure(settings, 'myntra', describeMyntraError(err));
    // An Akamai block (err.blocked) is not an expired login — no expiry
    // alert. But if Myntra keeps blocking for ~30 min (15 checks at 2 min),
    // orders aren't being checked at all — say so once.
    if (err.blocked) await noteMyntraBlocked(settings);
    if (isSessionRejected(err)) {
      // Session-expired warnings go only to the primary account, not the
      // full broadcast list — the other recipients don't manage sessions.
      // Waits a little first if the extension can restore it (lib/sessionAlerts.js).
      await noteSessionFailure(settings, 'myntra', '⚠️ Myntra session expired. Paste a fresh session on the admin page.', { sessionDoc });
    }
    const wrapped = new Error(`Poll failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    wrapped.status = status;
    throw wrapped;
  }

  await settings.updateOne(
    { _id: 'status' },
    {
      $set: {
        ...sessionOkFields('myntra'),
        ...checkOkFields('myntra'),
        myntraBlockedStreak: 0,
        myntraBlockedAlertSent: false,
        lastError: '',
        lastCheck: new Date().toISOString(),
        openCount: orders.length,
      },
    },
    { upsert: true }
  );
  // What the dashboard's order grid shows — it reads this instead of calling
  // Myntra itself (lib/ordersSnapshot.js). Never allowed to break the alert run.
  await saveMyntraOpenOrders(orders).catch((err) => console.error('open-orders snapshot failed:', err.message));

  const { newCount, deferred } = await alertNewOrders(db, orders, headers);
  // Item detail for any open order the dashboard doesn't have yet (orders
  // already open before this cache existed) — a few per run, never throws.
  await backfillMyntraOrderItems(orders, headers);

  return { openCount: orders.length, newCount, deferred };
}

module.exports = { runCheckOrders };
