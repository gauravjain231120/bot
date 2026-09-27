const { queueRowsForOrder, removeUnits, unshipLine } = require('./pendingQueue');
const { sendOwnerAlert } = require('./telegram');
const { escapeHtml } = require('./html');

// One cancelled order, processed step by step with every step's progress
// saved on its seen-cancellation document — shared by Myntra
// (checkCancellations.js) and Amazon (checkAmazonCancellations.js).
//
// What it fixes (the old code, per order, once, all-or-nothing):
//   - Tracked per ORDER only: a second cancellation on an order already
//     handled (Red cancelled Monday, White Tuesday) was ignored — White stayed
//     queued and reserved. Now the marketplace's own "what's cancelled"
//     signature is kept; when it changes, only the NEW units are processed.
//   - Units cancelled before we ever queued the order (cancelled within the
//     2-minute poll gap) were "removed" anyway — taking a still-live unit of
//     the same product out of Ready to Ship. The new-order alert now records
//     those as `units.cancelledAtAlert`, the baseline here.
//   - Any failure (item fetch, queue read, a delete) marked it done anyway, or
//     fell back to deleting the whole order. Now nothing is done until every
//     step succeeded; a failed step is retried on the next check, resuming
//     from saved progress (never re-removing, never un-shipping twice).
//
// Document fields: signature/processed = last fully handled state;
// work = the in-progress state for the current signature (units to handle,
// removed, unshipped, unresolved, alert delivered); failingSince/ownerAlerted =
// retry bookkeeping; claimedAt = short lease so overlapping runs don't collide.

const LEASE_MS = 3 * 60 * 1000;
// Still failing this long → the owner is told once (it keeps retrying).
const OWNER_ALERT_AFTER_MS = 30 * 60 * 1000;

async function claimCancellation(col, id, now = Date.now()) {
  return col.findOneAndUpdate(
    { _id: id, $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now - LEASE_MS) } }] },
    { $set: { claimedAt: new Date(now) } },
    { returnDocument: 'after' }
  );
}

const sum = (o) => Object.values(o || {}).reduce((a, n) => a + (Number(n) || 0), 0);

/**
 * @param {object} p
 * @param p.col           seen-cancellation collection
 * @param p.doc           the claimed document for this order
 * @param p.orderId
 * @param p.sig           signature of what the marketplace reports as cancelled now
 * @param p.cancelledNow  { SUFFIX: { qty, sku, altOrderIds? } } cancelled units per variant, now
 * @param p.baseline      { SUFFIX: n } cancelled units already handled / never queued
 * @param p.known         we alerted (and queued) this order ourselves
 * @param p.sendAlert     async (newly: [{ suffix, sku, qty }]) => { sent }
 * @param p.label         'Myntra' | 'Amazon'
 * @returns {{ done: boolean, newlyUnits: number, removed: number, unshipped: number, unresolved: number, error?: string }}
 */
async function processCancellation({ col, doc, orderId, sig, cancelledNow, baseline, known, sendAlert, label }) {
  const save = (fields) => col.updateOne({ _id: doc._id }, { $set: fields });
  let work = doc.work && doc.work.sig === sig ? doc.work : null;
  if (!work) {
    const newly = {};
    for (const [suffix, c] of Object.entries(cancelledNow)) {
      const n = c.qty - (Number(baseline[suffix]) || 0);
      if (n > 0) newly[suffix] = n;
    }
    work = { sig, newly, removed: {}, unshipped: {}, unresolved: {}, alerted: sum(newly) === 0 };
    await save({ work });
  }
  const skuOf = (suffix) => (cancelledNow[suffix] && cancelledNow[suffix].sku) || suffix;
  const stats = () => ({ newlyUnits: sum(work.newly), removed: sum(work.removed), unshipped: sum(work.unshipped), unresolved: sum(work.unresolved) });

  // 1. The alert (everyone): only the units cancelled since last time.
  if (!work.alerted) {
    const newlyList = Object.entries(work.newly).map(([suffix, qty]) => ({ suffix, sku: skuOf(suffix), qty }));
    const res = await sendAlert(newlyList);
    if (res && res.sent > 0) {
      work.alerted = true;
      await save({ 'work.alerted': true });
    }
  }

  // 2. Ready to Ship: take the cancelled units out; what isn't there was
  //    already marked shipped → put that stock back. Only for orders we queued.
  if (known) {
    let rows = null;
    try {
      for (const [suffix, total] of Object.entries(work.newly)) {
        const need = total - (work.removed[suffix] || 0) - (work.unshipped[suffix] || 0) - (work.unresolved[suffix] || 0);
        if (need <= 0) continue;
        if (!rows) rows = await queueRowsForOrder(orderId);
        const removedNow = await removeUnits(rows, suffix, need, async (n) => {
          work.removed[suffix] = (work.removed[suffix] || 0) + n;
          await save({ [`work.removed.${suffix}`]: work.removed[suffix] });
        });
        const short = need - removedNow;
        if (short <= 0) continue;
        const altOrderIds = (cancelledNow[suffix] && cancelledNow[suffix].altOrderIds) || [];
        const r = await unshipLine({ orderId, sku: skuOf(suffix), qty: short, altOrderIds });
        if (r.reversed) {
          work.unshipped[suffix] = (work.unshipped[suffix] || 0) + r.reversed;
          await save({ [`work.unshipped.${suffix}`]: work.unshipped[suffix] });
        }
        if (r.remaining > 0) {
          work.unresolved[suffix] = (work.unresolved[suffix] || 0) + r.remaining;
          await save({ [`work.unresolved.${suffix}`]: work.unresolved[suffix] });
          await sendOwnerAlert(
            `⚠️ <b>Cancelled ${label} line not fully found</b>\nOrder ID: <code>${escapeHtml(orderId)}</code>\nSKU: <code>${escapeHtml(skuOf(suffix))}</code>\n` +
              `${r.remaining} unit(s) cancelled but not in Ready to Ship or reversible in Shipped${r.error ? ` (${escapeHtml(r.error)})` : ''} — please check stock manually.`
          ).catch((e) => console.error('unresolved-cancellation alert failed:', e.message));
        }
      }
    } catch (err) {
      return { done: false, error: `Ready to Ship: ${err.message}`, ...stats() };
    }
  }

  if (!work.alerted) return { done: false, error: 'cancel alert not delivered yet', ...stats() };

  // 3. All handled: this is the new baseline.
  const processed = { ...baseline };
  for (const [suffix, c] of Object.entries(cancelledNow)) processed[suffix] = Math.max(Number(processed[suffix]) || 0, c.qty);
  await save({ signature: sig, processed, work: null, failingSince: null, ownerAlerted: false, lastError: null, claimedAt: null, doneAt: new Date() });
  return { done: true, ...stats() };
}

/**
 * A cancellation that couldn't be processed this time: remember since when,
 * free the lease, and tell the owner once if it's been failing for 30 min.
 */
async function noteCancellationFailure(col, doc, orderId, error, label, now = Date.now()) {
  const since = doc.failingSince ? new Date(doc.failingSince).getTime() : now;
  const fields = { failingSince: new Date(since), lastError: String(error).slice(0, 300), claimedAt: null };
  const tellOwner = !doc.ownerAlerted && now - since >= OWNER_ALERT_AFTER_MS;
  if (tellOwner) {
    const res = await sendOwnerAlert(
      `⚠️ <b>${label} cancellation not processed yet</b>\nOrder ID: <code>${escapeHtml(orderId)}</code>\n` +
        `Still retrying for ${Math.round((now - since) / 60000)} min: ${escapeHtml(String(error).slice(0, 200))}\n` +
        `Until it goes through, check Ready to Ship for this order by hand.`
    ).catch(() => ({ sent: 0 }));
    if (res && res.sent > 0) fields.ownerAlerted = true;
  }
  await col.updateOne({ _id: doc._id }, { $set: fields });
}

module.exports = { claimCancellation, processCancellation, noteCancellationFailure, OWNER_ALERT_AFTER_MS };
