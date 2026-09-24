const { fetchSpfPaidClaims, fetchPackedOrderByTracking, isSessionRejected } = require('./myntra');
const { lookupReturnsByTracking, normalizeTracking, skuSuffixRaw } = require('./stock');

// Splits the SPF "paid" total into what each paid claim actually was.
//
// Myntra itself can't tell fake from wrong: its own `issueCategory` on a
// paid claim is almost always WRONG_RETURNS_RECEIVED_OTHER_SELLERS_PRODUCT
// (verified live, 70 of 72 paid claims) whether the customer sent back a
// counterfeit or a different product. That distinction only exists in
// stock-manager, where each returned parcel is graded FAKED / WRONG / GOOD /
// USED / DEFECTIVE when it's scanned in — so each paid claim is matched to
// its stock-manager return row by tracking id:
//
//   1. The claim's return tracking id (meta.returnTrackingId, MYSR/MYER…)
//      — how the dashboard's "Scan a Myntra return" logs it.
//   2. Failing that, the claim's ORIGINAL shipment tracking id — ~1 in 5
//      paid claims have no return tracking id at all, and those returns were
//      logged under the original label instead (verified live).
//
// Buckets (amounts always add up to the paid total exactly — summed in
// paise):
//   fake        graded FAKED
//   wrong       graded WRONG
//   unclear     the matching rows include BOTH a FAKED and a WRONG unit and
//               nothing narrows it to one — needs a person to look
//   gradedOther graded GOOD / USED / DEFECTIVE only — Myntra paid for it
//               anyway, so it's likely mis-graded in stock-manager
//   notLogged   no stock-manager return row for it at all
// Tickets whose claim couldn't even be fetched from Myntra have no amount to
// put anywhere; they're returned separately in `failed`.

const BUCKETS = ['fake', 'wrong', 'unclear', 'gradedOther', 'notLogged'];

const toPaise = (amount) => Math.round(amount * 100);

const isAuthError = (err) => isSessionRejected(err);

// A claim's seller SKU (stock-manager's own SKU format), via the original
// shipment's packed-order record — the same lookup resolveReturnByTrackingId
// uses. Only needed when one tracking id has several stock-manager rows to
// choose between, so it's fetched lazily and cached per tracking id.
function makeSellerSkuResolver(headers) {
  const cache = new Map();
  return async function resolveSellerSku(claim) {
    const tid = claim.originalTrackingId;
    if (!tid || claim.skuId == null) return null;
    if (!cache.has(tid)) {
      cache.set(
        tid,
        fetchPackedOrderByTracking(tid, headers).catch((err) => {
          if (isAuthError(err)) throw err;
          return [];
        }),
      );
    }
    const items = await cache.get(tid);
    const match = items.find((i) => i.skuId != null && String(i.skuId) === String(claim.skuId));
    return (match && match.sellerSkuCode) || null;
  };
}

// Picks the stock-manager row one paid claim corresponds to, out of the rows
// still unclaimed for its tracking id. Rows are consumed one unit at a time,
// so two claims on the same multi-item shipment can't both count the same
// returned unit.
function classifyAgainstRows(claim, rows) {
  let candidates = rows.filter((r) => r.remaining > 0);
  if (!candidates.length) {
    return { bucket: 'notLogged', detail: 'stock-manager has fewer units logged under this tracking id than Myntra paid claims for' };
  }

  if (claim.sellerSku) {
    const suffix = skuSuffixRaw(claim.sellerSku);
    const sameSku = candidates.filter((r) => skuSuffixRaw(r.sku) === suffix);
    if (sameSku.length) candidates = sameSku;
  }

  const conditions = new Set(candidates.map((r) => r.condition));
  // A paid claim is by definition for a claim-worthy unit, so if FAKED/WRONG
  // sits alongside GOOD rows (a real case: qty-2 shipment, one unit came back
  // fine, the other didn't), the FAKED/WRONG one is the unit Myntra paid for.
  if (conditions.has('FAKED') && conditions.has('WRONG')) {
    return { bucket: 'unclear', detail: 'this return has both a FAKED and a WRONG unit logged — can\'t tell which one this claim was for' };
  }
  const wanted = conditions.has('FAKED') ? 'FAKED' : conditions.has('WRONG') ? 'WRONG' : null;
  const row = wanted ? candidates.find((r) => r.condition === wanted) : candidates[0];
  row.remaining -= 1;

  if (wanted === 'FAKED') return { bucket: 'fake', sku: row.sku };
  if (wanted === 'WRONG') return { bucket: 'wrong', sku: row.sku };
  return { bucket: 'gradedOther', sku: row.sku, detail: `graded ${row.condition} in stock-manager, but Myntra paid the claim` };
}

// `options` is passed through to fetchSpfPaidClaims (cached tickets / stored
// paid claims — lib/spfCache.js).
async function fetchSpfPaidBreakdown(headers, options = {}) {
  const { paidTicketCount, claims, failed, fetchedCount } = await fetchSpfPaidClaims(headers, options);
  const totalPaise = claims.reduce((sum, c) => sum + toPaise(c.amount), 0);
  const result = {
    paidTotalAmount: totalPaise / 100,
    paidTicketCount,
    countedTicketCount: claims.length,
    failed,
    fetchedCount: fetchedCount ?? null,
    breakdown: null,
    breakdownError: null,
    review: [],
  };

  let returnsByTracking;
  try {
    returnsByTracking = await lookupReturnsByTracking(claims.flatMap((c) => [c.returnTrackingId, c.originalTrackingId]));
  } catch (err) {
    // The total is still right without stock-manager — only the split is lost.
    console.error('SPF paid breakdown: stock-manager lookup failed:', err.message);
    result.breakdownError = `Couldn't read stock-manager's return log: ${err.message}`;
    return result;
  }

  // Which tracking id each claim matched on, grouped so claims sharing one
  // (a multi-item shipment) share — and consume from — the same rows.
  const groups = new Map();
  const classified = [];
  for (const claim of claims) {
    const returnKey = normalizeTracking(claim.returnTrackingId);
    const originalKey = normalizeTracking(claim.originalTrackingId);
    let key = null;
    let matchedBy = null;
    if (returnKey && returnsByTracking.has(returnKey)) {
      key = returnKey;
      matchedBy = 'return tracking id';
    } else if (originalKey && returnsByTracking.has(originalKey)) {
      key = originalKey;
      matchedBy = 'original shipment tracking id';
    }
    if (!key) {
      classified.push({ claim, trackingId: returnKey || originalKey, bucket: 'notLogged', detail: 'no return logged in stock-manager under this tracking id' });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ claim, matchedBy });
  }

  const resolveSellerSku = makeSellerSkuResolver(headers);
  const newlyResolved = [];
  for (const [key, members] of groups) {
    const rows = returnsByTracking.get(key).map((r) => ({ ...r, remaining: r.qty }));
    const needsSku = members.length > 1 || new Set(rows.map((r) => r.condition)).size > 1;
    if (needsSku) {
      for (const m of members) {
        // Already worked out on an earlier reveal (stored with the claim) —
        // no Myntra call. `null` = looked up before, nothing found.
        if (m.claim.sellerSku !== undefined) continue;
        m.claim.sellerSku = await resolveSellerSku(m.claim);
        newlyResolved.push(m.claim);
      }
    }
    // Claims with a known SKU pick first, so an SKU-specific row goes to its
    // own claim rather than to a sibling that couldn't be narrowed.
    members.sort((a, b) => Number(Boolean(b.claim.sellerSku)) - Number(Boolean(a.claim.sellerSku)));
    for (const { claim, matchedBy } of members) {
      classified.push({ claim, trackingId: key, matchedBy, ...classifyAgainstRows(claim, rows) });
    }
  }

  const breakdown = Object.fromEntries(BUCKETS.map((b) => [b, { paise: 0, count: 0 }]));
  for (const c of classified) {
    breakdown[c.bucket].paise += toPaise(c.claim.amount);
    breakdown[c.bucket].count += 1;
    if (c.bucket !== 'fake' && c.bucket !== 'wrong') {
      result.review.push({
        bucket: c.bucket,
        ticketId: c.claim.ticketId,
        orderId: c.claim.orderId,
        trackingId: c.trackingId || null,
        matchedBy: c.matchedBy || null,
        amount: c.claim.amount,
        issueCategory: c.claim.issueCategory || null,
        detail: c.detail || null,
      });
    }
  }

  // Remember the SKUs just worked out, so the next reveal skips those calls.
  if (options.claimStore && newlyResolved.length) await options.claimStore.save(newlyResolved);

  const bucketPaise = BUCKETS.reduce((sum, b) => sum + breakdown[b].paise, 0);
  if (bucketPaise !== totalPaise || classified.length !== claims.length) {
    // Should be impossible — every claim lands in exactly one bucket. Refuse
    // to show a split that doesn't add up rather than show a wrong one.
    console.error('SPF paid breakdown does not add up', { bucketPaise, totalPaise, classified: classified.length, claims: claims.length });
    result.breakdownError = 'The fake/wrong split did not add up to the total, so it is not shown.';
    return result;
  }

  result.breakdown = Object.fromEntries(
    BUCKETS.map((b) => [b, { amount: breakdown[b].paise / 100, count: breakdown[b].count }]),
  );
  const order = Object.fromEntries(BUCKETS.map((b, i) => [b, i]));
  result.review.sort((a, b) => order[a.bucket] - order[b.bucket] || b.amount - a.amount);
  return result;
}

module.exports = { fetchSpfPaidBreakdown };
