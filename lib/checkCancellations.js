const { getDb } = require('./db');
const {
  fetchCancelledOrders,
  fetchOrderRows,
  groupOrderRows,
  pickImageUrl,
  formatCancelAlert,
  formatCancelHeader,
  formatItemCaption,
} = require('./myntra');
const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup } = require('./telegram');
const { lookupCategory } = require('./stock');
const { forgetMyntraOrderItems } = require('./ordersSnapshot');
const { skuSuffix } = require('./skuSuffix');
const { claimCancellation, processCancellation, noteCancellationFailure } = require('./cancellationSweep');
const { sendOwnerAlert } = require('./telegram');
const { escapeHtml } = require('./html');

// Myntra's item-detail endpoint still returns full data (image, size, colour)
// for a cancelled order, same as an open one — so a cancel alert can carry a
// photo and category exactly like a new-order alert, not just plain text.
// `items` = only the units cancelled since last time (never the whole order —
// see PROJECT.md, order 6026100011). Returns the Telegram delivery result.
async function sendCancelAlert(order, items) {
  if (items.length === 0) return sendTelegramMessage(formatCancelAlert(order));

  const header = formatCancelHeader(order, items.reduce((a, i) => a + (i.qty || 1), 0));
  const itemCaptions = [];
  const photos = [];
  for (const item of items) {
    const sku = item.sellerSkuCode || item.skuCode;
    const category = await lookupCategory(sku);
    itemCaptions.push(formatItemCaption(item, '', category));
    const imageUrl = pickImageUrl(item);
    if (imageUrl) photos.push(imageUrl);
  }

  const combinedCaption = `${header}\n\n${itemCaptions.join('\n\n')}`;
  if (photos.length === 0) return sendTelegramMessage(combinedCaption);
  if (photos.length === 1) return sendTelegramPhoto(photos[0], combinedCaption);
  return sendTelegramMediaGroup(photos.map((photo, i) => ({ photo, caption: i === 0 ? combinedCaption : undefined })));
}

// Myntra's cancelled list has no "last changed" field (checked live
// 2026-09-27: orderId, quantity, sellerOrderIds, …). What it does have per
// entry — the cancelled quantity and the seller order-line ids — changes when
// another unit of the same order is cancelled, so that's the signature. An
// order can also appear as more than one entry: they're summed.
function groupCancelList(orders) {
  const byId = new Map();
  for (const o of orders) {
    const id = String(o.orderId);
    const g = byId.get(id) || { order: o, quantity: 0, lineIds: new Set() };
    g.quantity += Number(o.quantity) || 0;
    for (const s of o.sellerOrderIds || []) g.lineIds.add(String(s));
    byId.set(id, g);
  }
  for (const g of byId.values()) g.sig = `${g.quantity}|${[...g.lineIds].sort().join(',')}`;
  return byId;
}

// Also collects each variant's portalOrderReleaseIds: Myntra logs a RETURN
// under that number (e.g. 100333710323), not the M-Direct order id (checked
// live, 5 of 5) — stock-manager keeps them with the un-ship so the returning
// RTO parcel isn't counted twice.
function cancelledBySuffix(rows) {
  const out = {};
  for (const it of groupOrderRows(rows, ['CANCELLED'])) {
    const k = skuSuffix(it.sku);
    if (!out[k]) out[k] = { qty: 0, sku: it.sku, item: it, altOrderIds: [] };
    out[k].qty += it.qty;
  }
  for (const row of rows || []) {
    if (row.status !== 'CANCELLED' || row.portalOrderReleaseId == null) continue;
    const k = skuSuffix(row.sellerSkuCode || row.skuCode);
    if (out[k] && !out[k].altOrderIds.includes(String(row.portalOrderReleaseId))) out[k].altOrderIds.push(String(row.portalOrderReleaseId));
  }
  return out;
}

// Units of the order that are NOT cancelled, per variant.
function liveBySuffix(rows) {
  const out = {};
  for (const row of rows || []) {
    if (row.status === 'CANCELLED') continue;
    const k = skuSuffix(row.sellerSkuCode || row.skuCode);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// Cancellations are processed until this long into a run; the rest wait for
// the next check.
const RUN_BUDGET_MS = 50 * 1000;
// Old-style records (before per-unit tracking) learn their baseline a few per
// run — one item-detail call each, no alert, no queue change. One whose
// detail can't be fetched is adopted as it stands after a few tries.
const ADOPT_PER_RUN = 10;
const ADOPT_MAX_FAILS = 3;
// The new-order alert for the same order is still working out what it
// queued: wait for it (up to this long) so the baseline is right.
const ORDER_ALERT_WAIT_MS = 15 * 60 * 1000;
// …and while it's being sent right now (its claim — orderClaims LEASE_MS),
// so the cancel alert follows it instead of being skipped as "not announced".
const ORDER_ALERT_LEASE_MS = 5 * 60 * 1000;
// Myntra's item detail has failed this long: stop asking (the owner is told)
// until the order's cancelled state changes. Until then it's asked again
// after a growing wait, not on every check.
const DETAIL_GIVE_UP_MS = 2 * 60 * 60 * 1000;
const DETAIL_BACKOFF_MIN = [5, 10, 20, 40, 60];

async function runCheckCancellations() {
  const db = await getDb();
  const settings = db.collection('settings');
  const seenCancellations = db.collection('seenCancellations');

  const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    throw new Error('No session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  // On the very first run ever, seed silently (as old-style records, which
  // then learn their baseline) instead of alerting on all of history.
  const isFirstRun = (await seenCancellations.estimatedDocumentCount()) === 0;

  let orders;
  try {
    orders = await fetchCancelledOrders(headers);
  } catch (err) {
    const status = err.response && err.response.status;
    await settings.updateOne(
      { _id: 'status' },
      { $set: { lastCancelError: `${new Date().toISOString()} HTTP ${status || ''} ${err.message}` } },
      { upsert: true }
    );
    const wrapped = new Error(`Cancellation poll failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    wrapped.status = status;
    throw wrapped;
  }

  const groups = groupCancelList(orders);
  await settings.updateOne(
    { _id: 'status' },
    { $set: { lastCancelError: '', lastCancelCheck: new Date().toISOString(), cancelledCount: groups.size } },
    { upsert: true }
  );

  const ids = [...groups.keys()];
  const existing = ids.length ? await seenCancellations.find({ _id: { $in: ids } }).toArray() : [];
  const docById = new Map(existing.map((d) => [d._id, d]));
  const newIds = ids.filter((id) => !docById.has(id));
  if (newIds.length) {
    await seenCancellations.bulkWrite(
      newIds.map((id) => ({
        updateOne: {
          filter: { _id: id },
          // First run: old-style (adopted later, silently). Otherwise a new
          // cancellation with no baseline yet.
          update: { $setOnInsert: isFirstRun ? { _id: id, seenAt: new Date() } : { _id: id, seenAt: new Date(), signature: null, processed: null } },
          upsert: true,
        },
      }))
    );
  }
  // A (partly) cancelled order's cached items are now out of date — the
  // dashboard's backfill re-fetches whatever's still open.
  if (newIds.length) await forgetMyntraOrderItems(newIds);

  // Which of these orders our new-order alert handled, and what was already
  // cancelled when it looked.
  const seenOrdersCol = db.collection('seenOrders');
  const seenOrderDocs = ids.length
    ? await seenOrdersCol.find({ _id: { $in: ids } }).project({ _id: 1, units: 1, alerted: 1, attempts: 1, claimedAt: 1, cancelledWhenShown: 1 }).toArray()
    : [];
  const seenOrderById = new Map(seenOrderDocs.map((d) => [d._id, d]));

  const started = Date.now();
  const result = { cancelledCount: groups.size, newCancelCount: 0, removedFromQueue: 0, unshippedQty: 0, unresolvedCount: 0, pending: 0, adopted: 0 };
  let adoptions = 0;
  for (const id of ids) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    const g = groups.get(id);
    const known = docById.get(id);
    // Old-style records learn their baseline; so does one adopted without it
    // (its detail never came) once its state changes — before anything on it
    // is processed, so old units are never re-announced or re-removed.
    const adopting =
      (known && !('signature' in known) && !known.work) || (!known && isFirstRun) || (known && known.blindAdopted && known.signature !== g.sig);
    // Fully handled and unchanged → nothing to do (no Myntra call).
    if (known && !adopting && known.signature === g.sig && !known.work) continue;
    // Gave up on this exact state — until it changes. Only the owner's notice
    // may still be owed (no Myntra call for that).
    if (known && known.gaveUpSig === g.sig) {
      if (!known.gaveUpNoticeSent) {
        // Under the claim, so two overlapping runs can't both send it.
        const held = await claimCancellation(seenCancellations, id);
        if (held && !held.gaveUpNoticeSent) await sendGiveUpNotice(seenCancellations, id, held.gaveUpReason || '');
        if (held) await seenCancellations.updateOne({ _id: id }, { $set: { claimedAt: null } });
      }
      continue;
    }
    if (adopting && adoptions >= ADOPT_PER_RUN) continue;

    const seenOrder = seenOrderById.get(id);
    // New records (with `attempts`) that haven't recorded their units yet: the
    // new-order alert is still on it, or never got to it.
    const alertStillBuilding = seenOrder && 'attempts' in seenOrder && seenOrder.alerted === false && !seenOrder.units;
    // Being sent right now: wait for it, or its "announced?" is still unknown.
    const alertInFlight =
      seenOrder && seenOrder.alerted === false && seenOrder.claimedAt && Date.now() - new Date(seenOrder.claimedAt).getTime() < ORDER_ALERT_LEASE_MS;
    const firstSeen = known && known.seenAt ? new Date(known.seenAt).getTime() : Date.now();
    if (!adopting && (alertInFlight || (alertStillBuilding && Date.now() - firstSeen < ORDER_ALERT_WAIT_MS))) {
      result.pending++;
      continue;
    }

    const doc = await claimCancellation(seenCancellations, id);
    if (!doc) continue;
    if (adopting) adoptions++; // tries count, not just successes

    // The same state was fetched on an earlier try that then failed further
    // on — reuse it instead of asking Myntra again.
    const snap = !adopting && doc.work && doc.work.sig === g.sig && doc.work.snapshot;
    let cancelledNow;
    let liveNow;
    if (snap) {
      ({ cancelledNow, liveNow } = JSON.parse(snap));
    } else {
      // Item detail that keeps failing is asked for again after a growing wait.
      const detailFails = !adopting && doc.failingSig === g.sig ? Number(doc.detailFails) || 0 : 0;
      const backoff = detailFails ? DETAIL_BACKOFF_MIN[Math.min(detailFails - 1, DETAIL_BACKOFF_MIN.length - 1)] * 60 * 1000 : 0;
      if (backoff && doc.detailFailAt && Date.now() - new Date(doc.detailFailAt).getTime() < backoff) {
        await seenCancellations.updateOne({ _id: id }, { $set: { claimedAt: null } });
        result.pending++;
        continue;
      }
      let rows;
      try {
        rows = await fetchOrderRows(id, headers);
      } catch (err) {
        if (adopting) {
          const fails = (Number(doc.adoptFails) || 0) + 1;
          // Can't learn it: accept this state as handled (the old code did
          // handle it) and learn the baseline when it next changes.
          const fields = fails >= ADOPT_MAX_FAILS ? { signature: g.sig, processed: null, blindAdopted: true } : {};
          await seenCancellations.updateOne({ _id: id }, { $set: { ...fields, adoptFails: fails, claimedAt: null } });
          continue;
        }
        // The packers must hear "STOP" even if the detail isn't available yet —
        // a plain alert once; the queue work is retried.
        await sendPlainOnce(seenCancellations, doc, g, seenOrder);
        const failingFor = doc.failingSig === g.sig && doc.failingSince ? Date.now() - new Date(doc.failingSince).getTime() : 0;
        if (failingFor >= DETAIL_GIVE_UP_MS) {
          // Stop asking Myntra now, whether or not the notice gets through
          // (it's retried on its own until it does).
          const reason = `Myntra's order detail failed for ${Math.round(failingFor / 60000)} min (${err.message})`;
          await seenCancellations.updateOne(
            { _id: id },
            { $set: { gaveUpSig: g.sig, gaveUpReason: reason, gaveUpNoticeSent: false, claimedAt: null } }
          );
          await sendGiveUpNotice(seenCancellations, id, reason);
          result.pending++;
          continue;
        }
        await noteCancellationFailure(seenCancellations, doc, id, `item details: ${err.message}`, 'Myntra', g.sig, Date.now(), {
          detailFails: detailFails + 1,
          detailFailAt: new Date(),
        });
        result.pending++;
        continue;
      }
      if (doc.detailFails) await seenCancellations.updateOne({ _id: id }, { $set: { detailFails: 0 } });
      cancelledNow = cancelledBySuffix(rows);
      liveNow = liveBySuffix(rows);
    }

    if (adopting) {
      // Learn the baseline: everything cancelled so far was handled the old way.
      const processed = Object.fromEntries(Object.entries(cancelledNow).map(([k, c]) => [k, c.qty]));
      await seenCancellations.updateOne({ _id: id }, { $set: { signature: g.sig, processed, blindAdopted: false, claimedAt: null } });
      // Adopted blind earlier, and more is cancelled now: which of the units
      // are new can't be told (the earlier state was never read), so nothing is
      // touched — but the packers hear "STOP" and the owner is asked to check.
      const before = Number(String(doc.signature || '').split('|')[0]) || 0;
      if (doc.blindAdopted && g.quantity > before) {
        await sendPlainOnce(seenCancellations, doc, g, seenOrder);
        await sendOwnerAlert(
          `⚠️ <b>Older Myntra order: more units cancelled</b>\nOrder ID: <code>${escapeHtml(id)}</code>\n` +
            `${before} → ${g.quantity} cancelled. Its earlier state was never read, so Ready to Ship was not changed — please check it by hand.`
        ).catch(() => {});
      }
      result.adopted++;
      continue;
    }

    const shown = Object.values(cancelledNow).reduce((a, c) => a + c.qty, 0);
    // Listed as cancelled, but no unit row says so yet (Myntra lag): the
    // packers still hear "STOP" now; the detail is waited for.
    if (shown === 0) await sendPlainOnce(seenCancellations, doc, g, seenOrder);

    // Queued by our new-order alert: it recorded the units — or it's an older
    // record from before that bookkeeping, when every alerted order was queued.
    const queuedByUs = !!seenOrder && (!!seenOrder.units || !('attempts' in seenOrder));
    // Only orders whose new-order alert went out get a cancel alert — one
    // nobody was told about would just be noise (same rule as Amazon).
    const announce = !!seenOrder && seenOrder.alerted !== false;
    const atAlert = (seenOrder && seenOrder.units) || {};
    const baseline = doc.processed || Object.fromEntries(Object.entries(atAlert).map(([k, u]) => [k, u.cancelledAtAlert || 0]));
    const complete = shown >= g.quantity;
    const r = await processCancellation({
      col: seenCancellations,
      doc,
      orderId: id,
      sig: g.sig,
      cancelledNow,
      liveNow,
      baseline,
      leftOut: async () => {
        const so = await seenOrdersCol.findOne({ _id: id }, { projection: { cancelledWhenShown: 1 } });
        return (so && so.cancelledWhenShown) || {};
      },
      queuedByUs,
      complete,
      expected: g.quantity,
      snapshot: JSON.stringify({ cancelledNow, liveNow }),
      label: 'Myntra',
      sendAlert: async (units) => {
        // Read fresh, now — after this state was stamped on the record (the
        // new-order alert reads that after claiming): whichever of the two
        // goes second sees the other. Being sent right now → announced next
        // check, once it's out.
        const so = await seenOrdersCol.findOne({ _id: id }, { projection: { alerted: 1, claimedAt: 1 } });
        if (so && so.alerted === false && so.claimedAt && Date.now() - new Date(so.claimedAt).getTime() < ORDER_ALERT_LEASE_MS) return { sent: 0 };
        if (!(so ? so.alerted !== false : announce)) return { sent: 1 };
        return sendCancelAlert(g.order, units.map((u) => ({ ...cancelledNow[u.suffix].item, qty: u.qty })));
      },
    });
    if (r.done && r.newlyUnits) result.newCancelCount++;
    result.removedFromQueue += r.removed;
    result.unshippedQty += r.unshipped;
    result.unresolvedCount += r.unresolved;
    if (!r.done) {
      if (!r.waiting) await noteCancellationFailure(seenCancellations, doc, id, r.error, 'Myntra', g.sig);
      result.pending++;
    }
  }
  return result;
}

// The owner's "gave up" notice for a cancellation whose Myntra detail never
// came — marked sent only once it's delivered (retried on later checks).
async function sendGiveUpNotice(col, id, reason) {
  const res = await sendOwnerAlert(
    `⚠️ <b>Myntra cancellation: gave up</b>\nOrder ID: <code>${escapeHtml(id)}</code>\n` +
      `${escapeHtml(reason)}, so it was never taken out of Ready to Ship. Please do that by hand.`
  ).catch(() => ({ sent: 0 }));
  if (res && res.sent > 0) await col.updateOne({ _id: id }, { $set: { gaveUpNoticeSent: true } });
}

// A plain "STOP" for this cancelled state, once — when the unit detail isn't
// there (yet). Only for orders whose new-order alert went out.
async function sendPlainOnce(col, doc, g, seenOrder) {
  if (doc.plainAlertedSig === g.sig || !seenOrder || seenOrder.alerted === false) return;
  const res = await sendCancelAlert(g.order, []);
  if (res.sent > 0) {
    doc.plainAlertedSig = g.sig;
    await col.updateOne({ _id: doc._id }, { $set: { plainAlertedSig: g.sig } });
  }
}

module.exports = { runCheckCancellations, groupCancelList, cancelledBySuffix, liveBySuffix };
