const axios = require('axios');
const { formatIST, formatISTDate, myntraShipByDateMs } = require('./dates');

const WAREHOUSE_ID = process.env.WAREHOUSE_ID || '89623';

function openOrdersUrl(start, fetchSize) {
  return (
    'https://partnersapi.myntrainfo.com/api/mdirect/orders/v2/open' +
    `?status=CREATED&fetchSize=${fetchSize}&start=${start}&sortBy=id&sortOrder=ASC&warehouseId=${WAREHOUSE_ID}` +
    '&sellerProcessingTimeOrderStatus=PROCESSABLE&priority=false&useDispatchWarehouseCutoff=true'
  );
}

function cancelledOrdersUrl(start, fetchSize) {
  return (
    'https://partnersapi.myntrainfo.com/api/mdirect/orders/cancel' +
    `?fetchSize=${fetchSize}&start=${start}&sortBy=lastModifiedOn&sortOrder=DESC&warehouseId=${WAREHOUSE_ID}`
  );
}

function otcUrl(tripType) {
  return `https://partnersapi.myntrainfo.com/api/location/otc?warehouse=${WAREHOUSE_ID}&trip=${tripType}`;
}

function packedOrdersUrl(start, fetchSize, startDateDMY, endDateDMY) {
  return (
    `https://partnersapi.myntrainfo.com/api/mdirect/orders/getPostPackedOrders/${WAREHOUSE_ID}` +
    `?start=${start}&fetchSize=${fetchSize}&status=ALL&startDate=${startDateDMY}&endDate=${endDateDMY}`
  );
}

// Myntra doesn't always reject an expired session with a real 401/403 — for
// this endpoint family it can respond HTTP 200 with the actual error embedded
// in the body instead (`status.sessionExpired: true`, `status.statusCode: 101`).
// Left unchecked, that silently looks like "0 open orders" forever: no error
// recorded, no session-expired alert ever sent, orders invisible indefinitely.
// Throwing the same shape a real 401 would lets the existing session-expired
// handling in checkOrders.js/checkCancellations.js cover this case too.
function throwIfSoftSessionExpired(data) {
  const status = data && data.status;
  if (status && (status.sessionExpired || status.statusCode === 101)) {
    const err = new Error(status.statusMessage || 'Myntra session expired');
    err.response = { status: 401, data };
    throw err;
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20; // safety cap (≤2000 orders) against any pagination-math edge case

// A hardcoded fetchSize=15 with no pagination would silently drop every
// order past the 15th once there were ever more than that many at once —
// confirmed this exact bug in the parallel Amazon integration (see
// lib/amazon.js), so this paginates off status.totalCount the same way
// instead of assuming one page always contains everything.
async function fetchAllPages(urlBuilder, headers) {
  let start = 0;
  let all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await axios.get(urlBuilder(start, PAGE_SIZE), { headers });
    throwIfSoftSessionExpired(res.data);
    const orders = extractOrders(res.data);
    all = all.concat(orders);
    const total =
      res.data && res.data.status && typeof res.data.status.totalCount === 'number'
        ? res.data.status.totalCount
        : all.length;
    start += orders.length;
    if (orders.length === 0 || start >= total) break;
  }
  return all;
}

// Deliberately NOT paginated like fetchOpenOrders — Myntra's cancel endpoint
// has no date bound at all (unlike open orders, which are naturally a small,
// bounded set), so fully paginating it would walk the seller's ENTIRE
// cancellation history. The first time that ran, it surfaced ~24 cancellations
// dating back months that had never been marked seen, and — since seenCancel-
// lations already had older entries so this wasn't treated as a first run —
// alerted every single one individually in one flood. A single bounded page
// is enough headroom for "anything cancelled since the last ~5-minute check"
// without ever re-opening the historical floodgate.
async function fetchCancelledOrders(headers) {
  const res = await axios.get(cancelledOrdersUrl(0, 50), { headers });
  throwIfSoftSessionExpired(res.data);
  return extractOrders(res.data);
}

function formatCancelAlert(order) {
  const orderDate = formatIST(order.orderDate);
  return (
    `❌❌❌❌ <b>Order cancelled</b>\n` +
    `Order ID: <code>${order.orderId}</code>\n` +
    `Qty: ${order.quantity ?? '?'}\n` +
    `Placed: ${orderDate}`
  );
}

// Header for the richer cancel alert (photo + category), used once item detail
// was actually fetched — same shape as formatOrderHeader, just cancelled framing.
// The quadruple ❌ is deliberate — a packer skimming a photo album needs this to
// read as "STOP, do not ship" at a glance, not blend in with a normal order alert.
function formatCancelHeader(order, itemCount = 1) {
  const orderDate = formatIST(order.orderDate);
  const multiLine = itemCount > 1 ? `🔀 <b>MULTI ORDER</b> (${itemCount} items)\n` : '';
  return (
    `❌❌❌❌ <b>Myntra order cancelled</b>\n` +
    multiLine +
    `Order ID: <code>${order.orderId}</code>\n` +
    `Placed: ${orderDate}`
  );
}

// Handles both response shapes seen in DevTools: a flat array of order objects,
// or an array wrapping nested `fulfilmentOrderGroups` lists.
function extractOrders(json) {
  const data = json && json.data;
  if (!Array.isArray(data)) return [];
  const orders = [];
  for (const item of data) {
    if (item && Array.isArray(item.fulfilmentOrderGroups)) {
      orders.push(...item.fulfilmentOrderGroups);
    } else if (item && item.orderId) {
      orders.push(item);
    }
  }
  return orders;
}

async function fetchOpenOrders(headers) {
  return fetchAllPages((start, fetchSize) => openOrdersUrl(start, fetchSize), headers);
}

// Myntra returns one row per physical unit (a qty-2 order of one variant comes
// back as two identical rows) — group by SKU so the rest of the pipeline deals
// in "this SKU, this many units" instead of duplicate per-unit rows.
//
// Each row carries its OWN status ('CREATED' or 'CANCELLED') — a multi-item
// order can have some units cancelled while others still ship, independent of
// whatever status the order-group-level list endpoints show. This used to be
// ignored entirely, merging every row for an order into one qty per SKU
// regardless of status: a still-live unit got folded in with an already-
// cancelled one sharing the same SKU. That double-counted a cancelled unit as
// live in the new-order alert (and over-reserved stock for it), and made the
// cancellation alert claim an untouched, still-shipping line was cancelled
// too (real incident: order 6026100011, 2026-09-20 — see PROJECT.md).
// `statuses` narrows to just the row statuses the caller actually wants
// grouped — 'CREATED' for "what's genuinely still open" (the default, for the
// new-order pipeline), 'CANCELLED' for "what was actually just cancelled"
// (checkCancellations.js).
async function fetchOrderItems(orderId, headers, statuses = ['CREATED']) {
  const url = `https://partnersapi.myntrainfo.com/api/mdirect/orders/${orderId}/open-order-details/${WAREHOUSE_ID}`;
  const res = await axios.get(url, { headers });
  throwIfSoftSessionExpired(res.data);
  const allRows = Array.isArray(res.data && res.data.data) ? res.data.data : [];
  const rows = allRows.filter((row) => statuses.includes(row.status));

  const bySku = new Map();
  for (const row of rows) {
    const sku = row.sellerSkuCode || row.skuCode;
    const existing = bySku.get(sku);
    if (existing) existing.qty += 1;
    else bySku.set(sku, { ...row, sku, qty: 1 });
  }
  return [...bySku.values()];
}

// Prefer the sharpest resolution Myntra offers instead of the small 360x480 one.
const IMAGE_RESOLUTION_PRIORITY = ['1080X1440', '540X720', '360X480', '180X240'];

function pickImageUrl(item) {
  const images = item.images || [];
  const chosen = images.find((im) => im.imageType === 'default') || images[0];
  if (!chosen) return null;
  const best = IMAGE_RESOLUTION_PRIORITY.find((res) => chosen.resolutions && chosen.resolutions[res]);
  const url = (best && chosen.resolutions[best]) || chosen.path;
  return url ? url.replace(/^http:\/\//, 'https://') : null;
}

function formatAlert(order) {
  const orderDate = formatIST(order.orderDate);
  const shipBy = formatISTDate(myntraShipByDateMs(order.orderDate));
  return (
    `🛒 <b>New Myntra order</b>\n` +
    `Order ID: <code>${order.orderId}</code>\n` +
    `Qty: ${order.quantity ?? '?'}\n` +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

// Sent once per order, ahead of one caption per unique SKU — so a multi-item
// order reads as one grouped alert instead of repeating Order ID/Placed/Ship by
// on every item.
function formatOrderHeader(order, itemCount = 1) {
  const orderDate = formatIST(order.orderDate);
  const shipBy = formatISTDate(myntraShipByDateMs(order.orderDate));
  const multiLine = itemCount > 1 ? `🔀 <b>MULTI ORDER</b> (${itemCount} items)\n` : '';
  return (
    `🛒 <b>New Myntra order</b>\n` +
    multiLine +
    `Order ID: <code>${order.orderId}</code>\n` +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

// The courier's pickup/return handover code (warehouse-level, not per-order).
// The envelope itself (`status.statusCode: 3 Success`) stays "success" even
// when no tripsheet is active yet — the "not available yet" signal lives per
// courier instead (`otcDetails[i].otc: null`, its own nested ERROR status),
// so that's read directly rather than treated as a request failure.
// `tripType` is 'PICKUP' or 'RETURN'.
async function fetchOtc(tripType, headers) {
  const res = await axios.get(otcUrl(tripType), { headers });
  throwIfSoftSessionExpired(res.data);
  const details = (res.data && res.data.otcDetails) || [];
  const byCourier = {};
  for (const d of details) {
    if (d && d.courierCode) byCourier[d.courierCode] = d.otc || null;
  }
  return byCourier; // e.g. { MYS: null, MYE: '1234' }
}

// Count of packets currently sitting at packetStatus "PACKED" — i.e. packed
// but NOT YET picked up by the courier — for a date range (inclusive, both
// dates DD-MM-YYYY). getPostPackedOrders returns every packet ever packed in
// that range regardless of what's happened to it since (a real capture showed
// rows with packetStatus "PICKED" and "SHIPPED" mixed in with "PACKED" ones,
// packedOn timestamps spanning well before the queried day too) — counting
// every row overcounted "packed" with orders that had already moved on.
// Filtering to packetStatus === 'PACKED' here is what makes this 0 when
// nothing is currently sitting packed-and-waiting, matching what the seller
// actually means by "packed count" (real incident: 2026-09-22, showed 20
// when everything for today had already been picked up).
//
// One page tops out at 50 rows, so this actually paginates rather than
// trusting the envelope's own `status.totalCount` blindly — stops the moment
// a page comes back shorter than PAGE_SIZE (the real last page), same
// end condition as fetchAllPages, with the same MAX_PAGES safety cap. Pages
// are walked by raw row count (not the filtered count) so pagination itself
// stays correct regardless of how many rows on a page match the filter.
async function fetchPackedCount(startDateDMY, endDateDMY, headers) {
  const PAGE_SIZE = 50;
  let start = 0;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await axios.get(packedOrdersUrl(start, PAGE_SIZE, startDateDMY, endDateDMY), { headers });
    throwIfSoftSessionExpired(res.data);
    const rows = (res.data && res.data.data) || [];
    total += rows.filter((r) => r.packetStatus === 'PACKED').length;
    if (rows.length < PAGE_SIZE) break;
    start += rows.length;
  }
  return total;
}

// Every status the SPF tickets list can be in — queried explicitly (Myntra's
// own frontend does the same, confirmed from a real captured request) so
// nothing is silently excluded by some different default filter server-side.
const SPF_TICKET_STATUSES = [
  'OPEN', 'IN_REVIEW', 'ACCEPT', 'REJECT', 'MANUAL', 'INVOICE_CREATED', 'INVOICE_INITIATED',
  'PAYMENT_INITIATED', 'PAYMENT_COMPLETED', 'AWAITING_SELLER_RESPONSE', 'AWAITING_AGENT_RESPONSE',
  'CLOSED', 'DISPUTED',
];

function spfTicketsUrl(page, pageSize) {
  const statusParams = SPF_TICKET_STATUSES.map((s) => `status=${s}`).join('&');
  return (
    `https://partnersapi.myntrainfo.com/api/spf/v2/getTickets` +
    `?fetchAccio=true&modelType=PPMP&page=${page}&pageSize=${pageSize}&${statusParams}`
  );
}

// Every SPF claim (ticket) ever raised — the raw rows, not just a tally.
// Paginates fully (`page`/`pageSize`, NOT the `start`/`fetchSize` shape the
// other endpoints use) — stops at the first short page, same end condition
// and MAX_PAGES safety cap as fetchAllPages/fetchPackedCount. Deliberately
// never called from the cron checks or the main dashboard's poll loop —
// only from the dedicated SPF status page, on demand, see
// app/spf-status/page.js. `returnId` is `null` on some tickets (too early
// in the claim's life to have a return recorded against it yet) — kept as
// `null` rather than dropped, since resolveTrackingIdsForTickets() below
// needs to tell "no return yet" apart from "lookup failed".
async function fetchSpfTickets(headers) {
  const PAGE_SIZE = 50;
  let page = 0;
  const tickets = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await axios.get(spfTicketsUrl(page, PAGE_SIZE), { headers });
    throwIfSoftSessionExpired(res.data);
    const rows = (res.data && res.data.data) || [];
    for (const row of rows) {
      tickets.push({
        ticketId: row.ticketId,
        orderId: row.orderId ?? null,
        returnId: row.returnId ?? null,
        status: row.status || 'UNKNOWN',
        createdOn: row.createdOn || null,
      });
    }
    if (rows.length < PAGE_SIZE) break;
    page += 1;
  }
  return tickets;
}

// "total claims", "approved" (ACCEPT), "paid" (PAYMENT_COMPLETED), "rejected"
// (REJECT), plus every other status along the way.
async function fetchSpfTicketCounts(headers) {
  const tickets = await fetchSpfTickets(headers);
  const byStatus = {};
  for (const t of tickets) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }
  return { total: tickets.length, byStatus };
}

const PAID_TOTAL_CONCURRENCY = 8;

// The ₹ total paid out — deliberately NOT part of fetchSpfTicketCounts()
// above. `finalAmount` does NOT come back on the getTickets list rows at all
// (verified live: a real PAYMENT_COMPLETED row has no `meta` field
// whatsoever) — it only exists in the per-claim `meta` JSON string returned
// by fetchNewClaim (the same endpoint fetchSpfClaims/
// fetchClaimTrackingByReturnId already use), queried by a ticket's
// `returnId`. So getting the real total costs one extra Myntra call PER PAID
// TICKET, run with limited concurrency like resolveTrackingIdsForTickets
// below — too heavy to run on every page load, only called from
// POST /api/spf-status/verify when the Paid card is actually revealed.
//
// ~15% of PAYMENT_COMPLETED tickets come back from getTickets with
// `returnId: null` (verified live) — fetchNewClaim also accepts a ticket's
// `orderId` and returns that same ticket's claim, so it's used as a
// fallback lookup key rather than silently dropping those tickets from the
// total. The returned claim's own `ticketId` is checked against the ticket
// being looked up, in case an order ever has more than one SPF ticket.
async function fetchSpfPaidTotal(headers) {
  const tickets = await fetchSpfTickets(headers);
  const paid = tickets.filter((t) => t.status === 'PAYMENT_COMPLETED' && (t.returnId || t.orderId));
  const queue = [...paid];
  let paidTotalAmount = 0;

  async function worker() {
    while (queue.length) {
      const ticket = queue.shift();
      try {
        const lookupId = ticket.returnId || ticket.orderId;
        const res = await axios.get(spfClaimByIdUrl(lookupId), { headers });
        throwIfSoftSessionExpired(res.data);
        const rows = (res.data && res.data.data) || [];
        const claim = rows.find((c) => c.ticketId === ticket.ticketId) || rows[0];
        let meta = null;
        try {
          meta = claim && claim.meta ? JSON.parse(claim.meta) : null;
        } catch {
          meta = null;
        }
        const amount = meta && meta.finalAmount != null ? Number(meta.finalAmount) : null;
        if (Number.isFinite(amount)) paidTotalAmount += amount;
      } catch {
        // one ticket's claim detail failing shouldn't blow up the whole total
      }
    }
  }

  await Promise.all(Array.from({ length: PAID_TOTAL_CONCURRENCY }, worker));
  return { paidTotalAmount, paidTicketCount: paid.length };
}

function spfClaimByIdUrl(id) {
  return `https://partnersapi.myntrainfo.com/api/spf/fetchNewClaim?fetchAccio=true&id=${encodeURIComponent(id)}`;
}

// One ticket's actual Myntra return tracking id (MYSR.../MYER.../MYEC...) —
// fetchNewClaim (the same endpoint the return-scan flow already uses, §21)
// turns out to accept a ticket's `returnId` just as well as a return
// tracking id (verified live: querying by returnId returns the identical
// claim shape, `meta.returnTrackingId` included) — genuinely useful here
// since the ticket list itself never includes a tracking id.
async function fetchClaimTrackingByReturnId(returnId, headers) {
  const res = await axios.get(spfClaimByIdUrl(returnId), { headers });
  throwIfSoftSessionExpired(res.data);
  const claim = ((res.data && res.data.data) || [])[0];
  if (!claim) return null;
  let meta = {};
  try {
    meta = claim.meta ? JSON.parse(claim.meta) : {};
  } catch {
    meta = {};
  }
  return { returnTrackingId: meta.returnTrackingId || null, originalTrackingId: claim.trackingId || null };
}

// Resolves a return tracking id for every given ticket that has a
// `returnId` (tickets without one — too early in the claim's life — are
// left with tracking ids null rather than attempted). This is genuinely N
// live Myntra calls, one per ticket, so it's run with limited concurrency
// rather than all at once. Not wired to any UI or route — deliberately kept
// as a reusable library function for one-off analysis scripts (e.g.
// cross-checking SPF claims against stock-manager's own return log), the
// same role fetchSpfClaims/resolveReturnByTrackingId already play elsewhere
// in this file. Never called automatically.
const TRACKING_LOOKUP_CONCURRENCY = 8;

async function resolveTrackingIdsForTickets(tickets, headers) {
  const queue = tickets.filter((t) => t.returnId);
  const results = [];
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const ticket = queue[next];
      next += 1;
      try {
        const tracking = await fetchClaimTrackingByReturnId(ticket.returnId, headers);
        results.push({ ...ticket, ...(tracking || { returnTrackingId: null, originalTrackingId: null }) });
      } catch (err) {
        results.push({ ...ticket, returnTrackingId: null, originalTrackingId: null, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: TRACKING_LOOKUP_CONCURRENCY }, worker));
  // Stable, newest-first order (same as the ticket list itself) rather than
  // whatever order the concurrent workers happened to finish in.
  const order = new Map(tickets.map((t, i) => [t.ticketId, i]));
  results.sort((a, b) => (order.get(a.ticketId) ?? 0) - (order.get(b.ticketId) ?? 0));
  return results;
}

function spfClaimUrl(returnTrackingId) {
  return `https://partnersapi.myntrainfo.com/api/spf/fetchNewClaim?fetchAccio=true&id=${encodeURIComponent(returnTrackingId)}`;
}

function packedOrderSearchUrl(trackingNumber) {
  return (
    `https://partnersapi.myntrainfo.com/api/mdirect/orders/searchPostPackedOrder/${WAREHOUSE_ID}` +
    `?searchOn=trackingNumber&id=${encodeURIComponent(trackingNumber)}`
  );
}

// Step 1 of resolving a return: the Seller Protection Fund claim lookup, by
// the RETURN tracking id (e.g. MYSR...). Gives back the ORIGINAL outbound
// shipment's tracking id (different number, e.g. MYSP...) and the one
// product photo Myntra's own SPF page shows — used as-is, never the bigger
// multi-angle image set from step 2 below (asked for specifically).
//
// **Returns EVERY claim, not just the first** — a real, confirmed case: when
// the original shipment carried more than one product, `data` comes back
// with one entry PER PRODUCT, each with its own `skuId`/`styleInfo`, all
// sharing the same `trackingId`. Silently taking `data[0]` would drop every
// item but the first and could log the wrong product entirely for a
// multi-item order. `skuId` on each claim is what step 2 uses to pick the
// matching line item, not position/order.
async function fetchSpfClaims(returnTrackingId, headers) {
  const res = await axios.get(spfClaimUrl(returnTrackingId), { headers });
  throwIfSoftSessionExpired(res.data);
  const claims = (res.data && res.data.data) || [];
  return claims.map((claim) => {
    const rawImage = (claim.styleInfo && claim.styleInfo.imageLink) || null;
    return {
      trackingId: claim.trackingId || null, // original shipment tracking id
      returnTrackingId: claim.returnTrackingId || returnTrackingId,
      skuId: claim.skuId ?? null,
      image: rawImage ? rawImage.replace(/^http:\/\//, 'https://') : null,
      returnReason: claim.returnReason || null,
      returnMode: claim.returnMode || null,
      productName: (claim.styleInfo && claim.styleInfo.styleBasic && claim.styleInfo.styleBasic.name) || null,
      // Myntra's own "DD-MM-YYYY HH:mm:ss" string, already IST — shown as-is,
      // not reparsed, so there's no risk of a timezone-conversion bug.
      returnCreatedDate: claim.returnCreatedDate || null,
    };
  });
}

// Step 2: the ORIGINAL shipment's own packed-order record, by ITS tracking
// id (from step 1) — this is where the real seller SKU + size actually live,
// not in the SPF claim itself. Returns EVERY line item on that shipment (a
// multi-item order packs as ONE order record with multiple `lineItems`, each
// with its own `skuId`) — the caller matches the right one by `skuId`,
// never just `lineItems[0]`.
async function fetchPackedOrderByTracking(trackingNumber, headers) {
  const res = await axios.get(packedOrderSearchUrl(trackingNumber), { headers });
  throwIfSoftSessionExpired(res.data);
  const order = (res.data && res.data.data && res.data.data[0]) || null;
  const items = (order && order.lineItems) || [];
  return items.map((item) => ({
    skuId: item.skuId ?? null,
    sellerSkuCode: item.sellerSkuCode || null,
    size: item.size || null,
    color: item.color || null,
  }));
}

/**
 * The full "scan a Myntra return tracking id, get back what to log" lookup —
 * chains fetchSpfClaims (id -> one or more claims, each with an original
 * tracking id + photo) into fetchPackedOrderByTracking (that tracking id ->
 * every line item on that shipment), matching each claim to its own line
 * item by `skuId`. Returns an ARRAY, always — one entry per claim found (so
 * a single-item return is just an array of length 1, no special-casing
 * needed by callers), or an empty array if no claim was found at all. A
 * claim found but with no resolvable SKU still gets an entry (image/reason
 * intact), with sku/size/color left null so the caller can say exactly
 * what's missing instead of silently dropping that item.
 */
async function resolveReturnByTrackingId(returnTrackingId, headers) {
  const claims = await fetchSpfClaims(returnTrackingId, headers);
  if (!claims.length) return [];

  // Several claims can share the same original trackingId (one multi-item
  // shipment) — fetch each DISTINCT tracking id's line items once, not once
  // per claim.
  const trackingIds = [...new Set(claims.map((c) => c.trackingId).filter(Boolean))];
  const lineItemsByTracking = new Map();
  for (const tid of trackingIds) {
    lineItemsByTracking.set(tid, await fetchPackedOrderByTracking(tid, headers));
  }

  return claims.map((claim) => {
    const items = claim.trackingId ? lineItemsByTracking.get(claim.trackingId) || [] : [];
    const matched = items.find((i) => i.skuId != null && i.skuId === claim.skuId) || (items.length === 1 ? items[0] : null);
    return {
      returnTrackingId: claim.returnTrackingId,
      originalTrackingId: claim.trackingId,
      image: claim.image,
      returnReason: claim.returnReason,
      returnMode: claim.returnMode,
      returnCreatedDate: claim.returnCreatedDate,
      productName: claim.productName,
      sku: matched ? matched.sellerSkuCode : null,
      size: matched ? matched.size : null,
      color: matched ? matched.color : null,
    };
  });
}

function formatItemCaption(item, stockLine = '', category = '') {
  const categoryLine = category ? `Category: ${category}\n` : '';
  return (
    categoryLine +
    `SKU: <code>${item.sellerSkuCode || item.skuCode}</code>\n` +
    `Size: ${item.size || '?'}${item.color ? ` | Color: ${item.color}` : ''}\n` +
    `Qty: ${item.qty ?? 1}\n` +
    stockLine
  ).trim();
}

module.exports = {
  fetchOpenOrders,
  fetchCancelledOrders,
  fetchOrderItems,
  fetchOtc,
  fetchPackedCount,
  fetchSpfTickets,
  fetchSpfTicketCounts,
  fetchSpfPaidTotal,
  resolveTrackingIdsForTickets,
  fetchSpfClaims,
  fetchPackedOrderByTracking,
  resolveReturnByTrackingId,
  pickImageUrl,
  formatAlert,
  formatOrderHeader,
  formatItemCaption,
  formatCancelAlert,
  formatCancelHeader,
  formatIST,
  WAREHOUSE_ID,
};
