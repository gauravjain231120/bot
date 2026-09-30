const { getDb } = require('./db');
const { noteSessionFailure, sessionOkFields, sessionReplaced } = require('./sessionAlerts');
const { noteCheckFailure, checkOkFields } = require('./failureStreak');
const {
  fetchUnshippedByProgram,
  pickAmazonImage,
  formatAmazonAlert,
  formatAmazonOrderHeader,
  formatAmazonItemCaption,
  groupAmazonItemsBySku,
  amazonOrderDateMs,
  amazonShipByDateMs,
  isSignIn,
} = require('./amazon');
const { sendOwnerAlert } = require('./telegram');
const { makePayload, sendPayload, cancelledOf, retryReservations } = require('./alertPayload');
const { lookupStock, formatStockLine, lookupCategory } = require('./stock');
const { addToReadyToShip } = require('./readyToShip');
const { saveAmazonUnshippedOrders } = require('./ordersSnapshot');
const { sweepPartlyCancelledAmazonOrders } = require('./checkAmazonCancellations');
const { escapeHtml } = require('./html');
const { skuSuffix } = require('./skuSuffix');
const { recordSeen, pendingAlerts, claimAlert, markAlerted, releaseAlert, expireAlerts, MAX_ATTEMPTS } = require('./orderClaims');

// Goes only to whoever has Owner role, like the session-expired alerts, since
// it needs someone to add the order by hand.
async function alertQueueFailure(orderId, detail) {
  await sendOwnerAlert(
    `⚠️ <b>Amazon order not added to Ready to Ship</b>\nOrder ID: <code>${escapeHtml(orderId)}</code>\n${detail}\nPlease add it manually.`
  ).catch((err) => console.error('Ready-to-Ship failure alert failed:', err.message));
}

// One header per order, then one caption per unique SKU (qty-aggregated) —
// grouped into a single Telegram album when there's more than one, so a
// multi-item order reads as one alert instead of several. Goes to everyone
// (broadcast list), same as always — only the "not added to Ready to Ship"
// failure alert above is primary-only.
//
// Returns { delivered, units, payload } — units: per SKU suffix, units queued
// and units already cancelled when we first looked (the cancel sweep's
// baseline), handed to `onUnits` before anything is reserved; payload: the
// built alert, resent as is if Telegram didn't take it (lib/alertPayload.js).
async function sendAmazonOrderAlert(order, { openCount = null, onUnits = async () => {} } = {}) {
  const items = groupAmazonItemsBySku(order.orderItems);
  const units = {};
  for (const it of items) {
    const u = (units[skuSuffix(it.sellerSku)] ||= { queued: 0, cancelledAtAlert: 0 });
    u.queued += it.qty;
    u.cancelledAtAlert += it.cancelledQty || 0;
  }
  if (items.length) await onUnits(units);
  const live = items.filter((i) => i.qty > 0);
  if (live.length === 0) {
    // Nothing to reserve: no line items came back, or every unit is already
    // cancelled. The latter needs no alert at all; the former needs a person.
    if (items.length) return { delivered: true, units };
    const payload = makePayload(formatAmazonAlert(order, openCount));
    const res = await sendPayload(payload, 'amazon');
    await alertQueueFailure(order.amazonOrderId, 'Amazon returned no line items, so nothing could be added.');
    return { delivered: res.sent > 0, units: null, payload };
  }

  // Telegram's media-group album only shows ONE caption inline in the chat
  // (the first photo's) — on mobile the rest are hidden until the album is
  // opened. So every item's SKU/size/stock detail is joined into that single
  // caption alongside the header, instead of spreading one caption per photo.
  // The header's own count is total UNITS, not distinct SKU lines — 2 of one
  // item plus 1 of another reads as "3 items", matching the photo count below.
  const totalQty = live.reduce((a, i) => a + (i.qty || 1), 0);
  const header = formatAmazonOrderHeader(order, totalQty, openCount);
  const itemCaptions = [];
  const photos = [];
  const unreserved = [];

  for (const item of live) {
    // Reserve THIS order's stock before reading the stock line, not after —
    // see the matching comment in checkOrders.js's sendOrderAlert for why:
    // reading first showed a number that was already stale the instant the
    // reservation below landed a moment later.
    const add = {
      sku: item.sellerSku,
      qty: item.qty,
      channel: 'AMAZON',
      orderId: order.amazonOrderId,
      placedAtMs: amazonOrderDateMs(order),
      shipByMs: amazonShipByDateMs(order),
    };
    const added = await addToReadyToShip(add);
    if (!added.ok) {
      unreserved.push({ ...add, notifiedError: added.error });
      await alertQueueFailure(order.amazonOrderId, `SKU <code>${escapeHtml(item.sellerSku)}</code>: ${escapeHtml(added.error)}`);
    }
    const stock = await lookupStock(item.sellerSku);
    const category = await lookupCategory(item.sellerSku);
    itemCaptions.push(formatAmazonItemCaption(item, formatStockLine(stock), category));
    // One photo per physical unit, not one per line — a qty-2 row means two
    // copies of its photo, so the album's photo count is how many pieces to
    // pull off the shelf, not how many distinct products are in the order.
    const imageUrl = pickAmazonImage(item);
    if (imageUrl) {
      for (let i = 0; i < Math.max(1, item.qty || 1); i++) photos.push(imageUrl);
    }
  }

  const payload = makePayload(`${header}\n\n${itemCaptions.join('\n\n')}`, photos, new Date(), cancelledOf(units), unreserved);
  const res = await sendPayload(payload, 'amazon');
  return { delivered: res.sent > 0, units, payload };
}

// Same as the Myntra check (lib/checkOrders.js alertNewOrders): claimed,
// delivered-or-retried (a built alert is resent as is), time-boxed. Orders the
// cancel check has already seen cancelled are skipped (both checks run on the
// same tick) — and a stored alert built before a line was cancelled is rebuilt.
const ALERT_BUDGET_MS = 50 * 1000;

async function alertNewAmazonOrders(db, orders) {
  const seen = db.collection('seenAmazonOrders');
  const byId = new Map(orders.map((o) => [String(o.amazonOrderId), o]));
  const ids = [...byId.keys()];
  await recordSeen(seen, ids);
  for (const id of await expireAlerts(seen, ids)) await giveUpAlert(id, 'for 24 hours');
  const cancelledIds = new Set(
    ids.length ? (await db.collection('seenAmazonCancellations').find({ _id: { $in: ids } }).project({ _id: 1 }).toArray()).map((d) => d._id) : []
  );
  const pending = (await pendingAlerts(seen, ids)).filter((id) => !cancelledIds.has(id));
  const started = Date.now();
  let alerted = 0;
  let deferred = 0;
  for (const id of pending) {
    if (Date.now() - started > ALERT_BUDGET_MS) {
      deferred++;
      continue;
    }
    const doc = await claimAlert(seen, id);
    if (!doc) continue;
    let saved = null;
    try {
      const order = byId.get(id);
      // The stored alert still matches the order unless a line was cancelled since.
      const cancelledNow = (order.orderItems || []).reduce((a, i) => a + (Number(i.quantityCanceled) || 0), 0);
      const cancelledThen = Object.values((doc.alertPayload && doc.alertPayload.cancelled) || {}).reduce((a, n) => a + (Number(n) || 0), 0);
      let res;
      if (doc.alertPayload && cancelledNow === cancelledThen) {
        // Resend as stored — after retrying any reservation that failed.
        const still = await retryReservations(doc.alertPayload, alertQueueFailure);
        if (JSON.stringify(still) !== JSON.stringify(doc.alertPayload.unreserved || [])) saved = { ...doc.alertPayload, unreserved: still };
        res = { delivered: (await sendPayload(doc.alertPayload, 'amazon')).sent > 0, payload: doc.alertPayload };
      } else {
        res = await sendAmazonOrderAlert(order, {
          openCount: ids.length,
          onUnits: (units) => (doc.units ? null : seen.updateOne({ _id: id, units: null }, { $set: { units } })),
        });
        saved = res.payload || null;
      }
      if (res.delivered) {
        // Units the delivered alert left out as cancelled (every unit, when all
        // were cancelled before it went out).
        const shown = res.payload ? res.payload.cancelled || {} : res.units ? cancelledOf(res.units) : null;
        await markAlerted(seen, id, shown ? { cancelledWhenShown: shown } : {});
        alerted++;
      } else {
        const { gaveUp } = await releaseAlert(seen, id, doc, saved ? { alertPayload: saved } : {});
        if (gaveUp) await giveUpAlert(id);
      }
    } catch (err) {
      console.error(`New Amazon order alert for ${id} failed:`, err.message);
      const { gaveUp } = await releaseAlert(seen, id, doc, saved ? { alertPayload: saved } : {});
      if (gaveUp) await giveUpAlert(id);
    }
  }
  return { newCount: alerted, deferred };
}

async function giveUpAlert(orderId, how = `after ${MAX_ATTEMPTS} tries`) {
  await sendOwnerAlert(
    `⚠️ <b>Amazon order alert could not be sent</b>\nOrder ID: <code>${escapeHtml(orderId)}</code>\n` +
      `Kept failing ${how}. Check the order in Seller Central and that it's in Ready to Ship.`
  ).catch((err) => console.error('give-up alert failed:', err.message));
}

// A 403 that isn't Amazon's sign-in answer is usually a one-off request block
// (it clears up by itself) — treated as a temporary error, not an expired
// session. Only if it keeps happening this many checks in a row (5-min
// schedule → ~30 min) is it treated as expired after all, so a real outage in
// some unexpected shape still alerts and the extension still re-syncs.
const BLOCKED_STREAK_LIMIT = 6;

async function runCheckAmazonOrders({ proxyData = null } = {}) {

  const db = await getDb();
  const settings = db.collection('settings');
  const statusDoc = await settings.findOne({ _id: 'status' }) || {};

  if (!proxyData) {
    if (statusDoc.amazonLastProxyCheck) {
      const msSinceProxy = Date.now() - new Date(statusDoc.amazonLastProxyCheck).getTime();
      // Default to 5 mins as requested, but if they set interval to 5+, pad it by 90s so it doesn't false-alarm
      const userIntervalMs = (statusDoc.amazonProxyInterval || 4) * 60 * 1000;
      const fallbackMs = Math.max(5 * 60 * 1000, userIntervalMs + 90000); 
      
      if (msSinceProxy < fallbackMs) {
        // Extension is actively checking, skip cloud check
        return;
      }
    }
    // We are falling back to Cloud
    if (statusDoc.amazonScrapeMode === 'local') {
      await sendOwnerAlert('☁️ <b>Amazon switched to Cloud Backup</b>\nThe laptop/browser went offline.', { silent: true }).catch(() => {});
      await settings.updateOne({ _id: 'status' }, { $set: { amazonScrapeMode: 'cloud' } });
    }
    // JITTER: Randomly delay 1 to 12 seconds so the WAF doesn't see perfect robotic timing.
    const jitterMs = Math.floor(Math.random() * 11000) + 1000;
    await new Promise(r => setTimeout(r, jitterMs));
  } else {
    // Proxy (Extension) is checking
    if (statusDoc.amazonScrapeMode !== 'local') {
      await sendOwnerAlert('💻 <b>Amazon switched to Local Browser</b>\nThe laptop/browser is online and checking orders.', { silent: true }).catch(() => {});
    }
    await settings.updateOne({ _id: 'status' }, { $set: { amazonLastProxyCheck: new Date().toISOString(), amazonScrapeMode: 'local' } }, { upsert: true });
  }


  const sessionDoc = await settings.findOne({ _id: 'session_amazon' });
  if (!proxyData && (!sessionDoc || !sessionDoc.headers)) {
    await settings.updateOne(
      { _id: 'status' },
      { $set: { amazonLastError: `${new Date().toISOString()} No Amazon session saved yet` } },
      { upsert: true }
    );
    await noteSessionFailure(
      settings,
      'amazon',
      '⚠️ Amazon session missing. Paste a fresh session on the admin page (or let the browser extension sync one).',
      { sessionDoc: null }
    );
    throw new Error('No Amazon session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc ? sessionDoc.headers : null;

  let orders;
  try {
    // Easy Ship only (lib/amazon.js ALL_PROGRAMS) — no self-ship on this account.
    orders = proxyData ? proxyData : Object.values(await fetchUnshippedByProgram(headers)).flat();
  } catch (err) {
    const status = err.response && err.response.status;
    // A newer session was saved while this check ran (the extension restored
    // it) — this failure belongs to the old copy; recording it would mark the
    // fresh session "expired" again and could even alert about it.
    if (await sessionReplaced(settings, 'session_amazon', headers)) {
      const stale = new Error(`Amazon poll failed on a session that has since been replaced: ${err.message}`);
      stale.status = status;
      throw stale;
    }
    const signedOut = isSignIn(err) || err.sessionExpired;
    let streak = 0;
    if (!signedOut && status === 403) {
      const prev = await settings.findOneAndUpdate(
        { _id: 'status' },
        { $inc: { amazonBlockedStreak: 1 } },
        { upsert: true, returnDocument: 'after', projection: { amazonBlockedStreak: 1 } }
      );
      streak = (prev && prev.amazonBlockedStreak) || 1; // driver v6+: returns the document itself
    }
    const persistentBlock = streak >= BLOCKED_STREAK_LIMIT;
    // A temporary block is worded without "HTTP 403" so /api/session/health
    // reports 'error', not 'expired' (no pointless extension re-sync).
    const text =
      !signedOut && status === 403 && !persistentBlock
        ? `blocked by Amazon (temporary, will retry — ${streak} in a row): ${err.message}`
        : `HTTP ${status || ''} ${err.message}${persistentBlock ? ` (refused ${streak} checks in a row)` : ''}`;
    await settings.updateOne({ _id: 'status' }, { $set: { amazonLastError: `${new Date().toISOString()} ${text}` } }, { upsert: true });
    if (!signedOut && status !== 403) await noteCheckFailure(settings, 'amazon', `HTTP ${status || ''} ${err.message}`);
    if (signedOut || persistentBlock) {
      // Session-expired warnings go only to the primary account, not the
      // full broadcast list — the other recipients don't manage sessions.
      // Waits a little first if the extension can restore it (lib/sessionAlerts.js).
      await noteSessionFailure(
        settings,
        'amazon',
        persistentBlock && !signedOut
          ? '⚠️ Amazon has refused the bot\'s session for ~30 min — it has probably expired. Log in to Seller Central in Chrome (the extension re-syncs) or paste a fresh session.'
          : '⚠️ Amazon session expired. Paste a fresh session on the admin page.',
        // A block isn't something the extension's re-sync can fix (its test
        // call gets blocked too) — no point waiting another 15 min for it.
        { sessionDoc, grace: !(persistentBlock && !signedOut) }
      );
    }
    const wrapped = new Error(`Amazon poll failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    wrapped.status = status;
    throw wrapped;
  }

  await settings.updateOne(
    { _id: 'status' },
    {
      $set: {
        ...sessionOkFields('amazon'),
        ...checkOkFields('amazon'),
        amazonBlockedStreak: 0,
        amazonLastError: '',
        amazonLastCheck: new Date().toISOString(),
        amazonOpenCount: orders.length,
      },
    },
    { upsert: true }
  );
  // What the dashboard's order grid shows (lib/ordersSnapshot.js) — never
  // allowed to break the alert run.
  await saveAmazonUnshippedOrders(orders).catch((err) => console.error('amazon orders snapshot failed:', err.message));

  const { newCount, deferred } = await alertNewAmazonOrders(db, orders);
  // A line cancelled on an order that's still open never reaches the
  // cancelled search — handled from this same list (no extra Amazon call).
  const partly = await sweepPartlyCancelledAmazonOrders(db, orders).catch((err) => {
    console.error('partly-cancelled Amazon orders:', err.message);
    return null;
  });

  return { openCount: orders.length, newCount, deferred, ...(partly && partly.newCancelCount ? { partlyCancelled: partly.newCancelCount } : {}) };
}

module.exports = { runCheckAmazonOrders };
