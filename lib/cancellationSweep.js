const { queueRowsForOrder, removeUnits, cancelQueueRow, unshipLine } = require('./pendingQueue');
const { sendOwnerAlert } = require('./telegram');
const { escapeHtml } = require('./html');
const { skuSuffix } = require('./skuSuffix');

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
// work = the in-progress state (units to handle, announced, removed,
// unshipped, unresolved, skipped, a delete in flight, a snapshot of the item
// detail) — kept across a signature change, so a second cancellation arriving
// mid-way never re-announces or re-removes the first one; failingSince/
// ownerAlerted = retry bookkeeping; claimedAt = short lease so overlapping
// runs don't collide.

const LEASE_MS = 3 * 60 * 1000;
// Still failing this long → the owner is told once (it keeps retrying).
const OWNER_ALERT_AFTER_MS = 30 * 60 * 1000;
// The list says more units are cancelled than the item detail shows yet
// (Myntra updates the two separately): what's visible is handled right away,
// the rest waited for this long before the owner is told and it's accepted.
const INCOMPLETE_WAIT_MS = 30 * 60 * 1000;

async function claimCancellation(col, id, now = Date.now()) {
  return col.findOneAndUpdate(
    { _id: id, $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now - LEASE_MS) } }] },
    { $set: { claimedAt: new Date(now) } },
    { returnDocument: 'after' }
  );
}

const sum = (o) => Object.values(o || {}).reduce((a, n) => a + (Number(n) || 0), 0);
const num = (o, k) => Number(o && o[k]) || 0;

/**
 * @param {object} p
 * @param p.col           seen-cancellation collection
 * @param p.doc           the claimed document for this order
 * @param p.orderId
 * @param p.sig           signature of what the marketplace reports as cancelled now
 * @param p.cancelledNow  { SUFFIX: { qty, sku, altOrderIds? } } cancelled units per variant, now
 * @param p.liveNow       { SUFFIX: n } units of the order NOT cancelled — an order we
 *                        didn't queue ourselves never loses more from Ready to Ship
 *                        than would leave these
 * @param p.baseline      { SUFFIX: n } cancelled units already handled / never queued
 * @param p.leftOut       { SUFFIX: n } units already cancelled in the new-order alert
 *                        that was delivered — never announced as cancelled (or an
 *                        async function returning it, read at the moment of deciding)
 * @param p.queuedByUs    our new-order alert queued this order (it recorded its units):
 *                        a shortfall is un-shipped and anything unresolved reported
 * @param p.complete      the unit detail accounts for everything the list says is
 *                        cancelled (false: Myntra's detail is lagging behind)
 * @param p.expected      units the list says are cancelled (for the lag message)
 * @param p.snapshot      JSON of the detail, kept so a retry needn't fetch it again
 * @param p.sendAlert     async (units: [{ suffix, sku, qty }]) => { sent }
 * @param p.label         'Myntra' | 'Amazon'
 * @returns {{ done: boolean, waiting?: boolean, newlyUnits: number, removed: number, unshipped: number, unresolved: number, error?: string }}
 */
async function processCancellation({
  col,
  doc,
  orderId,
  sig,
  cancelledNow,
  liveNow = {},
  baseline,
  leftOut = {},
  queuedByUs,
  complete = true,
  expected = null,
  snapshot = null,
  sendAlert,
  label,
  now = Date.now(),
}) {
  const save = (fields) => col.updateOne({ _id: doc._id }, { $set: fields });
  const prev = doc.work || {};
  const newly = {};
  for (const [suffix, c] of Object.entries(cancelledNow)) {
    const n = (Number(c.qty) || 0) - num(baseline, suffix);
    if (n > 0) newly[suffix] = n;
  }
  // Announced so far — an older in-progress record kept only a yes/no.
  const announced = { ...(prev.announced || (prev.alerted ? prev.newly : null) || {}) };
  // A plain "STOP" (no detail) already went out for exactly this state.
  if (doc.plainAlertedSig === sig) for (const [suffix, n] of Object.entries(newly)) announced[suffix] = Math.max(num(announced, suffix), n);
  const incompleteSince = complete ? null : prev.incompleteSince || new Date(now);
  // Lagging detail is fetched again each check (it may catch up) — but only
  // for INCOMPLETE_WAIT_MS; after that only the owner's notice is left to send,
  // and it's sent from this saved copy without asking Myntra again.
  const waitedOut = !complete && now - new Date(incompleteSince).getTime() >= INCOMPLETE_WAIT_MS;
  const work = {
    sig,
    newly,
    announced,
    removed: prev.removed || {},
    unshipped: prev.unshipped || {},
    unresolved: prev.unresolved || {},
    skipped: prev.skipped || {},
    deleting: prev.deleting || null,
    incompleteSince,
    snapshot: complete || waitedOut ? snapshot : null,
  };
  // `changedAt`: when the cancelled units this sweep sees last grew (a new
  // signature, or lagging detail catching up) — a stored new-order alert
  // built before that is out of date (lib/checkOrders.js rebuilds it).
  const changed = prev.sig !== sig || sum(newly) > sum(prev.newly);
  await save(changed ? { work, changedAt: new Date(now) } : { work });
  const skuOf = (suffix) => (cancelledNow[suffix] && cancelledNow[suffix].sku) || suffix;
  const stats = () => ({ newlyUnits: sum(work.newly), removed: sum(work.removed), unshipped: sum(work.unshipped), unresolved: sum(work.unresolved) });

  // 1. The alert (everyone): only units not announced before — nor left out of
  //    the new-order alert as already cancelled (read now, after this state
  //    was stamped: a new-order alert delivered meanwhile is seen).
  const lo = (typeof leftOut === 'function' ? await leftOut() : leftOut) || {};
  let seeded = false;
  for (const suffix of Object.keys(newly)) {
    const hidden = num(lo, suffix) - num(baseline, suffix);
    if (hidden > num(work.announced, suffix)) {
      work.announced[suffix] = hidden;
      seeded = true;
    }
  }
  if (seeded) await save({ 'work.announced': work.announced });
  const toAnnounce = Object.entries(newly)
    .map(([suffix, n]) => ({ suffix, sku: skuOf(suffix), qty: n - num(announced, suffix) }))
    .filter((u) => u.qty > 0);
  if (toAnnounce.length) {
    const res = await sendAlert(toAnnounce);
    if (res && res.sent > 0) {
      for (const u of toAnnounce) work.announced[u.suffix] = newly[u.suffix];
      await save({ 'work.announced': work.announced });
    }
  }
  const allAnnounced = Object.entries(newly).every(([suffix, n]) => num(work.announced, suffix) >= n);

  // 2. Ready to Ship: take the cancelled units out. What isn't there was
  //    already marked shipped → put that stock back — only for orders we
  //    queued ourselves; for any other (added by hand) just what's queued.
  let rows = null;
  const freshRows = async () => (rows ||= await queueRowsForOrder(orderId));
  try {
    if (work.deleting) {
      // A delete was in flight when the last run stopped: send the very same
      // request again — stock-manager answers a repeat with what the first one
      // took (or does it now), so a row that's gone is never guessed at.
      const d = work.deleting;
      let applied;
      if (d.requestId) {
        applied = await cancelQueueRow(d.rowId, d.take, d.requestId);
      } else {
        // Saved by the previous version (no request id): judge from the queue.
        const row = (await freshRows()).find((r) => String(r.id) === String(d.rowId));
        applied = !row ? d.take : Math.max(0, Math.min(d.take, d.qtyBefore - row.qty));
      }
      if (applied) work.removed[d.suffix] = num(work.removed, d.suffix) + applied;
      work.deleting = null;
      rows = null; // re-read: the queue changed under the old copy
      await save({ [`work.removed.${d.suffix}`]: num(work.removed, d.suffix), 'work.deleting': null });
    }
    for (const [suffix, total] of Object.entries(newly)) {
      const need = total - num(work.removed, suffix) - num(work.unshipped, suffix) - num(work.unresolved, suffix) - num(work.skipped, suffix);
      if (need <= 0) continue;
      const queued = (await freshRows()).filter((r) => r.qty > 0 && skuSuffix(r.sku) === suffix).reduce((a, r) => a + r.qty, 0);
      const takeable = queuedByUs ? need : Math.min(need, Math.max(0, queued - num(liveNow, suffix)));
      const removedNow = takeable
        ? await removeUnits(rows, suffix, takeable, {
            before: async (row, take) => {
              // Unique per cancellation, variant and step; stable if re-sent.
              const requestId = `qdel:${orderId}:${suffix}:${num(baseline, suffix)}:${num(work.removed, suffix)}:${row.id}`;
              work.deleting = { suffix, rowId: String(row.id), qtyBefore: row.qty, take, requestId };
              await save({ 'work.deleting': work.deleting });
              return requestId;
            },
            after: async (n) => {
              work.removed[suffix] = num(work.removed, suffix) + n;
              work.deleting = null;
              await save({ [`work.removed.${suffix}`]: work.removed[suffix], 'work.deleting': null });
            },
          })
        : 0;
      const short = need - removedNow;
      if (short <= 0) continue;
      if (!queuedByUs) {
        // Never queued by us and not (or no longer) in the queue — nothing of ours to undo.
        work.skipped[suffix] = num(work.skipped, suffix) + short;
        await save({ [`work.skipped.${suffix}`]: work.skipped[suffix] });
        continue;
      }
      const altOrderIds = (cancelledNow[suffix] && cancelledNow[suffix].altOrderIds) || [];
      // Unique per cancellation and step, stable across retries of it: the
      // units handled before this one (baseline) + the un-ship steps so far.
      const done = num(work.unshipped, suffix) + num(work.unresolved, suffix);
      const requestId = `cancel:${orderId}:${suffix}:${num(baseline, suffix)}:${done}`;
      const r = await unshipLine({ orderId, sku: skuOf(suffix), qty: short, altOrderIds, requestId });
      if (r.reversed) {
        work.unshipped[suffix] = num(work.unshipped, suffix) + r.reversed;
        await save({ [`work.unshipped.${suffix}`]: work.unshipped[suffix] });
      }
      if (r.remaining > 0) {
        work.unresolved[suffix] = num(work.unresolved, suffix) + r.remaining;
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

  if (!allAnnounced) return { done: false, error: 'cancel alert not delivered yet', ...stats() };

  if (!complete) {
    const since = new Date(incompleteSince).getTime();
    if (!waitedOut) {
      await save({ claimedAt: null });
      return { done: false, waiting: true, ...stats() };
    }
    // Waited long enough: tell the owner (once — until it's delivered the
    // record stays open) and accept what the detail shows.
    const shown = sum(Object.fromEntries(Object.entries(cancelledNow).map(([k, c]) => [k, c.qty])));
    const res = await sendOwnerAlert(
      `⚠️ <b>${label} cancellation only partly visible</b>\nOrder ID: <code>${escapeHtml(orderId)}</code>\n` +
        `The cancelled list says ${expected ?? '?'} unit(s), but after ${Math.round((now - since) / 60000)} min the order detail still shows ${shown}. ` +
        `Those ${shown} were handled; check Ready to Ship for the rest by hand.`
    ).catch(() => ({ sent: 0 }));
    if (!res || !(res.sent > 0)) return { done: false, error: 'partly-visible notice not delivered yet', ...stats() };
  }

  // 3. All handled: this is the new baseline.
  const processed = { ...baseline };
  for (const [suffix, c] of Object.entries(cancelledNow)) processed[suffix] = Math.max(num(processed, suffix), Number(c.qty) || 0);
  await save({ signature: sig, processed, work: null, failingSince: null, ownerAlerted: false, lastError: null, claimedAt: null, doneAt: new Date(now) });
  return { done: true, ...stats() };
}

/**
 * A cancellation that couldn't be processed this time: remember since when,
 * free the lease, and tell the owner once if it's been failing for 30 min.
 * The clock is per cancelled state (`sig`): a new cancellation on the order
 * starts it again — an earlier one's failures (or its give-up) don't count.
 */
async function noteCancellationFailure(col, doc, orderId, error, label, sig = null, now = Date.now(), extra = {}) {
  const same = doc.failingSig === sig;
  const since = same && doc.failingSince ? new Date(doc.failingSince).getTime() : now;
  const fields = { failingSince: new Date(since), failingSig: sig, lastError: String(error).slice(0, 300), claimedAt: null, ...extra };
  if (!same) fields.ownerAlerted = false;
  const tellOwner = !(same && doc.ownerAlerted) && now - since >= OWNER_ALERT_AFTER_MS;
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

module.exports = { claimCancellation, processCancellation, noteCancellationFailure, OWNER_ALERT_AFTER_MS, INCOMPLETE_WAIT_MS };
