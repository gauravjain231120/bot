const { getDb } = require('./db');
const { noteSessionFailure, sessionOkFields, sessionReplaced } = require('./sessionAlerts');
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
const { sendOwnerAlert } = require('./telegram');
const { makePayload, sendPayload, cancelledOf, retryReservations, withStaleWarning } = require('./alertPayload');
const { lookupStock, formatStockLine, lookupCategory } = require('./stock');
const { addToReadyToShip } = require('./readyToShip');
const { myntraShipByDateMs } = require('./dates');
const { saveMyntraOpenOrders, cacheMyntraOrderItems, backfillMyntraOrderItems } = require('./ordersSnapshot');
const { escapeHtml } = require('./html');
const { skuSuffix } = require('./skuSuffix');
const { recordSeen, pendingAlerts, claimAlert, markAlerted, releaseAlert, expireAlerts, MAX_ATTEMPTS } = require('./orderClaims');

// Goes only to whoever has Owner role, like the session-expired alerts, since
// it needs someone to add the order by hand.
async function alertQueueFailure(orderId, detail) {
  await sendOwnerAlert(
    `⚠️ <b>Myntra order not added to Ready to Ship</b>\nOrder ID: <code>${escapeHtml(orderId)}</code>\n${detail}\nPlease add it manually.`
  ).catch((err) => console.error('Ready-to-Ship failure alert failed:', err.message));
}

// One header per order, then one caption per unique SKU (already qty-aggregated
// by fetchOrderItems) — grouped into a single Telegram album when there's more
// than one, so a multi-item order reads as one alert instead of several. Goes
// to everyone (broadcast list), same as always — only the "not added to
// Ready to Ship" failure alert above is primary-only.
//
// `onUnits(units)` is awaited as soon as the order's rows are read — BEFORE
// anything is reserved — so the cancel sweep always knows what this alert is
// about to queue (lib/checkCancellations.js waits while it's not recorded).
//
// Returns { delivered, units, payload, retryLater }:
//   delivered   the alert reached at least one recipient (or there was nothing
//               to alert: every unit already cancelled)
//   units       per SKU suffix: units queued and units ALREADY cancelled when
//               we first looked — the cancel sweep must never "remove" those
//               from Ready to Ship, they were never put there
//   payload     the built alert, to resend as is if Telegram didn't take it
//   retryLater  item detail couldn't be fetched — try again next check before
//               falling back to a plain alert
// `rebuild`: this order was already alerted-and-queued once (a stored alert
// being rebuilt after a cancellation) — detail that can't be fetched now just
// means "later"; never a plain alert or "add it by hand" (it IS queued).
async function sendOrderAlert(order, headers, { attempt = 1, openCount = null, onUnits = async () => {}, rebuild = false, engineMode = null } = {}) {
  const readAt = new Date();
  let rows = null;
  try {
    rows = await fetchOrderRows(order.orderId, headers);
  } catch (err) {
    console.error(`Could not fetch item details for order ${order.orderId}:`, err.message);
  }
  if (rows === null && (attempt < 2 || rebuild)) return { delivered: false, retryLater: true };
  const items = rows ? groupOrderRows(rows, ['CREATED']) : [];
  const cancelledEarly = rows ? groupOrderRows(rows, ['CANCELLED']) : [];
  const units = {};
  for (const it of items) (units[skuSuffix(it.sku)] ||= { queued: 0, cancelledAtAlert: 0 }).queued += it.qty;
  for (const it of cancelledEarly) (units[skuSuffix(it.sku)] ||= { queued: 0, cancelledAtAlert: 0 }).cancelledAtAlert += it.qty;
  if (rows && rows.length) await onUnits(units);
  // Reused by the dashboard's order grid, so it never has to fetch these itself.
  if (items.length) await cacheMyntraOrderItems(order.orderId, items);

  // Every unit was cancelled before we saw the order (list lag) — nothing to
  // ship, nothing to announce.
  if (rows && rows.length && items.length === 0 && cancelledEarly.length) return { delivered: true, units };
  // A rebuild that finds nothing it can show (the order moved on): keep the
  // stored alert, try later.
  if (rebuild && items.length === 0) return { delivered: false, retryLater: true };

  if (items.length === 0) {
    const payload = makePayload(formatAlert(order, openCount), [], readAt);
          payload.engineMode = engineMode;
    const res = await sendPayload(payload, 'myntra');
    await alertQueueFailure(order.orderId, 'Could not fetch item details, so nothing could be added.');
    return { delivered: res.sent > 0, units: null, payload };
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
  const unreserved = [];

  for (const item of items) {
    const sku = item.sellerSkuCode || item.skuCode;
    // Reserve THIS order's stock before reading the stock line, not after —
    // reading it first showed a number that was already stale the instant
    // the reservation below landed a moment later (e.g. "1 left" in the
    // alert while stock-manager's own dashboard, updated by the very next
    // line, already read 0). Reading after addToReadyToShip means the number
    // shown is the true, current one — what stock-manager will show too.
    const add = {
      sku,
      qty: item.qty,
      channel: 'MYNTRA',
      orderId: order.orderId,
      placedAtMs: order.orderDate,
      shipByMs: myntraShipByDateMs(order.orderDate),
    };
    const added = await addToReadyToShip(add);
    if (!added.ok) {
      // On a rebuild it was most likely queued at the first build (the
      // duplicate check just couldn't answer): kept for the resend's retry,
      // which tells the owner if it really isn't there.
      unreserved.push(rebuild ? add : { ...add, notifiedError: added.error });
      if (!rebuild) await alertQueueFailure(order.orderId, `SKU <code>${escapeHtml(sku)}</code>: ${escapeHtml(added.error)}`);
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

  const payload = makePayload(`${header}\n\n${itemCaptions.join('\n\n')}`, photos, readAt, cancelledOf(units), unreserved);
  payload.engineMode = engineMode;
  const res = await sendPayload(payload, 'myntra');
  return { delivered: res.sent > 0, units, payload };
}

// New orders are alerted until this long into a run; the rest wait for the
// next check (2 min later) rather than risk the function being killed with
// alerts half-sent.
const ALERT_BUDGET_MS = 50 * 1000;
// A stored alert gone out of date is rebuilt (one Myntra call) at most this
// many times; after that it's sent as stored, with a warning line on top.
const MAX_REBUILD_TRIES = 3;

async function alertNewOrders(db, orders, headers, engineMode = null) {
  const seenOrders = db.collection('seenOrders');
  const byId = new Map(orders.map((o) => [String(o.orderId), o]));
  const ids = [...byId.keys()];
  await recordSeen(seenOrders, ids);
  // Undelivered for a whole day and still open: stop retrying, tell the owner.
  for (const id of await expireAlerts(seenOrders, ids)) await giveUpAlert(id, 'for 24 hours');
  const pending = await pendingAlerts(seenOrders, ids);
  const seenCancellations = db.collection('seenCancellations');
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
    let saved = null;
    const extra = {};
    try {
      // A stored alert built before part of the order was cancelled would show
      // the cancelled item — rebuilt instead (the rebuild is then newer).
      // `changedAt` moves with every cancellation the sweep sees; read now,
      // after claiming, so a sweep running alongside is always seen by one side.
      const c = doc.alertPayload ? await seenCancellations.findOne({ _id: id }, { projection: { seenAt: 1, changedAt: 1 } }) : null;
      const changedAt = c && (c.changedAt || c.seenAt);
      const stale = !!(doc.alertPayload && changedAt && new Date(changedAt) >= new Date(doc.alertPayload.builtAt));
      const rebuildTries = Number(doc.rebuildTries) || 0;
      let res;
      if (doc.alertPayload && (!stale || rebuildTries >= MAX_REBUILD_TRIES)) {
        // Resend as stored — after retrying any reservation that failed (not
        // when part of the order was cancelled since: it may be that part).
        if (!stale) {
          const still = await retryReservations(doc.alertPayload, alertQueueFailure);
          if (JSON.stringify(still) !== JSON.stringify(doc.alertPayload.unreserved || [])) saved = { ...doc.alertPayload, unreserved: still };
        }
        const payload = stale ? withStaleWarning(doc.alertPayload) : doc.alertPayload;
        payload.engineMode = engineMode;
        res = { delivered: (await sendPayload(payload, 'myntra')).sent > 0, payload: doc.alertPayload };
      } else {
        res = await sendOrderAlert(byId.get(id), headers, {
          attempt: doc.attempts,
          openCount: ids.length,
          rebuild: !!doc.alertPayload,
          // The first look at the order is the baseline for the cancel sweep —
          // never overwritten by a retry.
          onUnits: (units) => (doc.units ? null : seenOrders.updateOne({ _id: id, units: null }, { $set: { units } })),
          engineMode,
        });
        saved = res.payload || null;
        // A rebuild whose detail couldn't be fetched keeps the stored alert.
        if (doc.alertPayload && res.retryLater) extra.rebuildTries = rebuildTries + 1;
      }
      if (res.delivered) {
        // What the delivered alert already left out as cancelled (a rebuild
        // can leave out more than the first look did; an order with every
        // unit already cancelled left out all of them).
        const shown = res.payload ? res.payload.cancelled || {} : res.units ? cancelledOf(res.units) : null;
        await markAlerted(seenOrders, id, shown ? { cancelledWhenShown: shown } : {});
        alerted++;
      } else {
        const { gaveUp } = await releaseAlert(seenOrders, id, doc, { ...(saved ? { alertPayload: saved } : {}), ...extra });
        if (gaveUp) await giveUpAlert(id);
      }
    } catch (err) {
      console.error(`New-order alert for ${id} failed:`, err.message);
      const { gaveUp } = await releaseAlert(seenOrders, id, doc, saved ? { alertPayload: saved } : {});
      if (gaveUp) await giveUpAlert(id);
    }
  }
  return { newCount: alerted, deferred };
}

async function giveUpAlert(orderId, how = `after ${MAX_ATTEMPTS} tries`) {
  await sendOwnerAlert(
    `⚠️ <b>Myntra order alert could not be sent</b>\nOrder ID: <code>${escapeHtml(orderId)}</code>\n` +
      `Kept failing ${how}. Check the order on Myntra and that it's in Ready to Ship.`
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

async function runCheckOrders({ proxyData = null } = {}) {

  const db = await getDb();
  const settings = db.collection('settings');
  const statusDoc = await settings.findOne({ _id: 'status' }) || {};

  if (!proxyData) {
    if (statusDoc.myntraLastProxyCheck) {
      const msSinceProxy = Date.now() - new Date(statusDoc.myntraLastProxyCheck).getTime();
      // Default to 5 mins as requested, but if they set interval to 5+, pad it by 90s so it doesn't false-alarm
      const userIntervalMs = (statusDoc.myntraProxyInterval || 4) * 60 * 1000;
      const fallbackMs = Math.max(5 * 60 * 1000, userIntervalMs + 90000); 
      
      if (msSinceProxy < fallbackMs) {
        // Extension is actively checking, skip cloud check
        return;
      }
    }
    // We are falling back to Cloud
    if (statusDoc.myntraScrapeMode === 'local') {
      await sendOwnerAlert('☁️ <b>Myntra switched to Cloud Backup</b>\nThe laptop/browser went offline.', { silent: true }).catch(() => {});
      await settings.updateOne({ _id: 'status' }, { $set: { myntraScrapeMode: 'cloud' } });
    }
  } else {
    // Proxy (Extension) is checking
    if (statusDoc.myntraScrapeMode !== 'local') {
      await sendOwnerAlert('💻 <b>Myntra switched to Local Browser</b>\nThe laptop/browser is online and checking orders.', { silent: true }).catch(() => {});
    }
    await settings.updateOne({ _id: 'status' }, { $set: { myntraLastProxyCheck: new Date().toISOString(), myntraScrapeMode: 'local' } }, { upsert: true });
  }


  const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!proxyData && (!sessionDoc || !sessionDoc.headers)) {
    await settings.updateOne(
      { _id: 'status' },
      { $set: { lastError: `${new Date().toISOString()} No session saved yet` } },
      { upsert: true }
    );
    await noteSessionFailure(
      settings,
      'myntra',
      '⚠️ Myntra session missing. Paste a fresh session on the admin page (or let the browser extension sync one).',
      { sessionDoc: null }
    );
    throw new Error('No session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc ? sessionDoc.headers : null;

  let orders;
  try {
    orders = proxyData ? proxyData : await fetchOpenOrders(headers);
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

  const engineMode = proxyData ? 'local' : 'cloud';
  const { newCount, deferred } = await alertNewOrders(db, orders, headers, engineMode);
  // Item detail for any open order the dashboard doesn't have yet (orders
  // already open before this cache existed) — a few per run, never throws.
  await backfillMyntraOrderItems(orders, headers);

  return { openCount: orders.length, newCount, deferred };
}

module.exports = { runCheckOrders };
