// "Seen" + "alerted" bookkeeping for new-order alerts — Myntra (seenOrders)
// and Amazon (seenAmazonOrders) share it.
//
// An order used to be marked seen BEFORE its alert was sent, with nothing to
// say whether the alert actually went out: a Telegram refusal (bad photo, long
// caption, rate limit), a crash half-way through the loop, or the function
// being killed on time lost those alerts for good. Now each seen order carries
// `alerted`:
//   false     seen, alert not delivered yet → retried on the next check
//   true      delivered (to at least one recipient)
//   'failed'  gave up (the build failed MAX_ATTEMPTS times, or the built alert
//             still wasn't delivered after RETRY_WINDOW_MS) — the owner was told
//   (missing) seen before this existed — treated as done, never retried
// An order is CLAIMED before it's processed (atomic findOneAndUpdate with a
// short lease), so two checks running at once (the scheduler + "Check now")
// can never both alert — or both reserve — the same order.

// Builds — each one reads the marketplace and reserves in Ready to Ship —
// are tried this many times. Once an alert is built (`alertPayload` saved),
// only Telegram is retried: no limit on tries, until it's delivered or the
// window below runs out.
const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60 * 1000;
// Only orders first seen this recently are retried — an old unalerted one
// isn't news any more.
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

const canRetry = { $or: [{ attempts: { $lt: MAX_ATTEMPTS } }, { alertPayload: { $exists: true } }] };

/** Mark ids seen (first sight: not alerted yet). */
async function recordSeen(col, ids, now = Date.now()) {
  if (!ids.length) return;
  await col.bulkWrite(
    ids.map((id) => ({
      updateOne: {
        filter: { _id: id },
        update: { $setOnInsert: { _id: id, seenAt: new Date(now), alerted: false, attempts: 0 } },
        upsert: true,
      },
    }))
  );
}

/** Of `ids`, the ones whose alert still needs sending (oldest first). */
async function pendingAlerts(col, ids, now = Date.now()) {
  if (!ids.length) return [];
  const docs = await col
    .find({ _id: { $in: ids }, alerted: false, seenAt: { $gt: new Date(now - RETRY_WINDOW_MS) }, ...canRetry })
    .project({ _id: 1, seenAt: 1 })
    .toArray();
  return docs.sort((a, b) => new Date(a.seenAt) - new Date(b.seenAt)).map((d) => d._id);
}

/** Claim one order for processing; null if someone else holds it or it's done. */
async function claimAlert(col, id, now = Date.now()) {
  return col.findOneAndUpdate(
    {
      _id: id,
      alerted: false,
      seenAt: { $gt: new Date(now - RETRY_WINDOW_MS) },
      $and: [canRetry, { $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now - LEASE_MS) } }] }],
    },
    { $set: { claimedAt: new Date(now) }, $inc: { attempts: 1 } },
    { returnDocument: 'after' }
  );
}

async function markAlerted(col, id, extra = {}) {
  await col.updateOne({ _id: id }, { $set: { alerted: true, alertedAt: new Date(), claimedAt: null, ...extra }, $unset: { alertPayload: '' } });
}

/**
 * Not delivered this time — free it for the next check. Gives up (alerted:
 * 'failed') only when the build itself failed MAX_ATTEMPTS times; a built
 * alert is resent until it's delivered or expireAlerts ends it.
 */
async function releaseAlert(col, id, doc, extra = {}) {
  const gaveUp = !!doc && doc.attempts >= MAX_ATTEMPTS && !doc.alertPayload && !extra.alertPayload;
  await col.updateOne({ _id: id }, { $set: { claimedAt: null, ...(gaveUp ? { alerted: 'failed' } : {}), ...extra } });
  return { gaveUp };
}

/**
 * Of `ids` (orders still open), the built-but-never-delivered ones whose retry
 * window has run out — each marked failed here, exactly once, for the caller
 * to tell the owner.
 */
async function expireAlerts(col, ids, now = Date.now()) {
  if (!ids.length) return [];
  const docs = await col
    .find({ _id: { $in: ids }, alerted: false, alertPayload: { $exists: true }, seenAt: { $lt: new Date(now - RETRY_WINDOW_MS) } })
    .project({ _id: 1 })
    .toArray();
  const out = [];
  for (const d of docs) {
    const won = await col.findOneAndUpdate({ _id: d._id, alerted: false }, { $set: { alerted: 'failed', claimedAt: null } }, { returnDocument: 'after' });
    if (won) out.push(d._id);
  }
  return out;
}

module.exports = { recordSeen, pendingAlerts, claimAlert, markAlerted, releaseAlert, expireAlerts, MAX_ATTEMPTS, RETRY_WINDOW_MS };
