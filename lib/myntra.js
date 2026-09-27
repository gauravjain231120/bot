const axios = require('axios');
const { formatIST, formatISTDate, myntraShipByDateMs } = require('./dates');
const { persistRolledCookies } = require('./myntraCookies');
const { escapeHtml } = require('./html');

// Every Myntra request goes through here (never axios.get directly):
//  1. Saves the refreshed cookies Myntra sends back (lib/myntraCookies.js),
//     so the stored session keeps rolling like a browser's instead of aging
//     out while the seller is still logged in.
//  2. A bare HTTP 403 whose body isn't Myntra's own JSON is Akamai's bot
//     manager (Myntra fronts this API with it — ak_bmsc / bm_sv cookies), not
//     a session problem: retried once after a short pause before it's
//     treated as a failure. `err.blocked` marks one that stayed blocked, so
//     callers/logs can tell it apart from a real expiry (a real expiry is a
//     200 with statusCode 101 — see throwIfSoftSessionExpired below).
const BLOCK_RETRY_DELAY_MS = 2500;
// No Myntra call may hang a cron run: 20s is far more than a real answer takes.
const MYNTRA_TIMEOUT_MS = 20000;
// A request that got NO answer at all (connection reset / timed out / DNS
// blip) says nothing about the session — retried once after a short pause
// (read-only GETs, safe to repeat) instead of failing the whole check.
const NETWORK_RETRY_DELAY_MS = 1500;
const isNetworkError = (err) => !!err && !err.response && err.code !== 'ERR_CANCELED';

function isAkamaiBlock(err) {
  const r = err && err.response;
  if (!r || r.status !== 403) return false;
  const d = r.data;
  return !(d && typeof d === 'object' && d.status);
}

async function myntraGet(url, headers) {
  const get = () => axios.get(url, { headers, timeout: MYNTRA_TIMEOUT_MS });
  let res;
  try {
    res = await get();
  } catch (err) {
    const blocked = isAkamaiBlock(err);
    if (!blocked && !isNetworkError(err)) throw err;
    await new Promise((r) => setTimeout(r, blocked ? BLOCK_RETRY_DELAY_MS : NETWORK_RETRY_DELAY_MS));
    try {
      res = await get();
    } catch (err2) {
      if (isAkamaiBlock(err2)) err2.blocked = true;
      throw err2;
    }
  }
  await persistRolledCookies(headers, res);
  return res;
}

/** True when Myntra actually rejected the session (401 / soft "expired" /
 *  its own JSON 403) — NOT when Akamai merely blocked a request (err.blocked),
 *  which says nothing about the login and clears up by itself. */
function isSessionRejected(err) {
  const status = err && err.response && err.response.status;
  return status === 401 || (status === 403 && !err.blocked);
}

/** Text for a status lastError. A block is worded without "HTTP 403" so the
 *  health endpoint reads it as a temporary error, not an expired session
 *  (which would make the extension re-sync for nothing). */
function describeMyntraError(err) {
  if (err && err.blocked) return `blocked by Myntra's bot protection (temporary, will retry): ${err.message}`;
  const status = err && err.response && err.response.status;
  return `HTTP ${status || ''} ${err && err.message}`;
}

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
// Myntra answers some failures with HTTP 200 and an error envelope
// (`status.statusType: "ERROR"`, e.g. the packed list's 5-day limit) or, from
// an edge/bot page, with a non-JSON body. Read as data, both used to become an
// empty list — "0 open orders", no error, no alert. Now they throw.
function throwIfErrorEnvelope(data, what) {
  const bodyIsText = typeof data === 'string';
  const status = data && typeof data === 'object' ? data.status : null;
  if (!bodyIsText && !(status && String(status.statusType || '').toUpperCase() === 'ERROR')) return;
  const err = new Error(`Myntra ${what}: ${bodyIsText ? 'unexpected non-JSON answer' : status.statusMessage || 'error answer'}`);
  err.response = { status: 502, data: bodyIsText ? String(data).slice(0, 300) : data };
  throw err;
}

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
    const res = await myntraGet(urlBuilder(start, PAGE_SIZE), headers);
    throwIfSoftSessionExpired(res.data);
    throwIfErrorEnvelope(res.data, 'order list');
    const orders = extractOrders(res.data);
    all = all.concat(orders);
    const total =
      res.data && res.data.status && typeof res.data.status.totalCount === 'number'
        ? res.data.status.totalCount
        : all.length;
    start += orders.length;
    if (orders.length === 0 || start >= total) break;
  }
  return dedupeOrders(all);
}

// One entry per orderId (a nested/flattened response or a page boundary can
// repeat one) — a repeat would mean a second alert for the same order.
function dedupeOrders(orders) {
  const seen = new Set();
  return orders.filter((o) => {
    const id = String(o && o.orderId);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
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
  const res = await myntraGet(cancelledOrdersUrl(0, 50), headers);
  throwIfSoftSessionExpired(res.data);
  throwIfErrorEnvelope(res.data, 'cancelled list');
  return extractOrders(res.data);
}

function formatCancelAlert(order) {
  const orderDate = formatIST(order.orderDate);
  return (
    `❌❌❌❌ <b>Order cancelled</b>\n` +
    `Order ID: <code>${escapeHtml(order.orderId)}</code>\n` +
    `Qty: ${escapeHtml(order.quantity ?? '?')}\n` +
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
    `Order ID: <code>${escapeHtml(order.orderId)}</code>\n` +
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
  return groupOrderRows(await fetchOrderRows(orderId, headers), statuses);
}

// Every unit row of an order, whatever its status — one call gives both what's
// still live (CREATED) and what's cancelled, so the new-order alert can record
// "units already cancelled before we queued anything" for the cancel sweep.
async function fetchOrderRows(orderId, headers) {
  const url = `https://partnersapi.myntrainfo.com/api/mdirect/orders/${orderId}/open-order-details/${WAREHOUSE_ID}`;
  const res = await myntraGet(url, headers);
  throwIfSoftSessionExpired(res.data);
  throwIfErrorEnvelope(res.data, 'order details');
  return Array.isArray(res.data && res.data.data) ? res.data.data : [];
}

/** Rows with one of `statuses`, one entry per SKU with qty = number of unit rows. */
function groupOrderRows(allRows, statuses = ['CREATED']) {
  const bySku = new Map();
  for (const row of allRows || []) {
    if (!statuses.includes(row.status)) continue;
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
    `Order ID: <code>${escapeHtml(order.orderId)}</code>\n` +
    `Qty: ${escapeHtml(order.quantity ?? '?')}\n` +
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
    `Order ID: <code>${escapeHtml(order.orderId)}</code>\n` +
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
  const res = await myntraGet(otcUrl(tripType), headers);
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
    const res = await myntraGet(packedOrdersUrl(start, PAGE_SIZE, startDateDMY, endDateDMY), headers);
    throwIfSoftSessionExpired(res.data);
    const rows = (res.data && res.data.data) || [];
    total += rows.filter((r) => r.packetStatus === 'PACKED').length;
    if (rows.length < PAGE_SIZE) break;
    start += rows.length;
  }
  return total;
}

// Every packet packed in the last 4 days (IST: today + the 3 days before), one
// per packet, with its current status — for the dashboard's "Myntra packed" card:
// "waiting for pickup" = status PACKED (whatever day it was packed; the
// per-day fetchPackedCount above, still used by Telegram /packed, missed a
// packet packed yesterday and still waiting), and "packed today" = packed
// today, picked up yet or not.
//
// getPostPackedOrders refuses a range longer than 5 days — verified live
// 2026-09-27: a 14-day range answered HTTP 200 with statusType ERROR
// "Difference between start date and end date should not be greater than 5
// days" and no rows, which the first version of this read as "0 packed"
// while 19 were waiting. The seller wants the last 4 days only (2026-09-27):
// one window of PACKED_WINDOW_DAYS (end − start = 3 days, inside the limit).
// The windows loop stays so a longer look-back is just PACKED_WINDOWS; an
// ERROR answer always throws — never a silent wrong zero.
//
// Speed: page 1 of a window carries `status.totalCount`, so its remaining
// pages are fetched 3 at a time; if a window's last page still comes back
// full (totalCount was stale), it carries on page by page. MAX_PAGES caps
// each window (`capped: true` = there may be more).
const PACKED_WINDOW_DAYS = 4; // Myntra allows at most 5 (end − start ≤ 5 days)
const PACKED_WINDOWS = 1; // → the last 4 days, as the seller asked
const PACKED_PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function istDMY(ms) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ms)).split('-');
  return `${d}-${m}-${y}`;
}

// One window: endMs's IST day and the (PACKED_WINDOW_DAYS − 1) days before it.
async function fetchPackedWindow(headers, endMs) {
  const startDate = istDMY(endMs - (PACKED_WINDOW_DAYS - 1) * DAY_MS);
  const endDate = istDMY(endMs);
  const page = async (start) => {
    const res = await myntraGet(packedOrdersUrl(start, PACKED_PAGE_SIZE, startDate, endDate), headers);
    throwIfSoftSessionExpired(res.data);
    const status = (res.data && res.data.status) || {};
    const data = res.data && res.data.data;
    if (String(status.statusType || '').toUpperCase() === 'ERROR' || (data != null && !Array.isArray(data))) {
      const err = new Error(`Myntra packed list: ${status.statusMessage || 'unexpected answer'}`);
      err.response = { status: 502, data: res.data };
      throw err;
    }
    return { rows: data || [], totalCount: Number(status.totalCount) };
  };

  const first = await page(0);
  const pages = [first.rows];
  let next = PACKED_PAGE_SIZE;
  if (first.rows.length === PACKED_PAGE_SIZE && Number.isFinite(first.totalCount)) {
    const starts = [];
    for (let s = next; s < first.totalCount && starts.length < MAX_PAGES - 1; s += PACKED_PAGE_SIZE) starts.push(s);
    for (let i = 0; i < starts.length; i += 3) {
      const batch = await Promise.all(starts.slice(i, i + 3).map((s) => page(s).then((r) => r.rows)));
      pages.push(...batch);
    }
    next += starts.length * PACKED_PAGE_SIZE;
  }
  while (pages[pages.length - 1].length === PACKED_PAGE_SIZE && pages.length < MAX_PAGES) {
    pages.push((await page(next)).rows);
    next += PACKED_PAGE_SIZE;
  }
  const capped = pages.length >= MAX_PAGES && pages[pages.length - 1].length === PACKED_PAGE_SIZE;
  return { rows: pages.flat(), capped, startDate, endDate };
}

async function fetchPackedPackets(headers, { windows = PACKED_WINDOWS, now = Date.now() } = {}) {
  const seen = new Set();
  const packets = [];
  let capped = false;
  let startDate = null;
  for (let w = 0; w < windows; w++) {
    const win = await fetchPackedWindow(headers, now - w * PACKED_WINDOW_DAYS * DAY_MS);
    capped = capped || win.capped;
    startDate = win.startDate;
    for (const r of win.rows) {
      const key = String(r.storePacketId ?? r.trackingNumber ?? '');
      if (key && seen.has(key)) continue; // a packet can show up in two windows
      if (key) seen.add(key);
      const packedOn = Number(r.packedOn) || Date.parse(r.packedOn) || null; // epoch ms (tolerates a date string)
      const pickBy = Number(r.pickByTime) || Date.parse(r.pickByTime) || null;
      packets.push({ status: r.packetStatus || null, packedOn, pickBy, trackingNumber: r.trackingNumber || null });
    }
  }
  return { packets, capped, days: windows * PACKED_WINDOW_DAYS, startDate, endDate: istDMY(now) };
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
// Up to 100 pages x 50 = 5,000 tickets (the shared MAX_PAGES = 1,000 would
// silently cut off a long claim history). Stops at the first short page.
const SPF_MAX_PAGES = 100;

async function fetchSpfTickets(headers) {
  const PAGE_SIZE = 50;
  let page = 0;
  const tickets = [];
  for (let i = 0; i < SPF_MAX_PAGES; i++) {
    const res = await myntraGet(spfTicketsUrl(page, PAGE_SIZE), headers);
    throwIfSoftSessionExpired(res.data);
    const rows = (res.data && res.data.data) || [];
    for (const row of rows) {
      tickets.push({
        ticketId: row.ticketId,
        orderId: row.orderId ?? null,
        returnId: row.returnId ?? null,
        skuId: row.skuId ?? null,
        status: row.status || 'UNKNOWN',
        // Myntra's own claim reason, e.g. WRONG_RETURNS_RECEIVED_OTHER_SELLERS_PRODUCT
        issueCategory: row.issueCategory || null,
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
// `tickets` = an already-loaded list (lib/spfCache.js) — skips the fetch.
async function fetchSpfTicketCounts(headers, tickets = null) {
  if (!tickets) tickets = await fetchSpfTickets(headers);
  const byStatus = {};
  for (const t of tickets) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }
  return { total: tickets.length, byStatus };
}

// 3 at a time (was 8): a paid-claims walk is the biggest burst the bot sends
// Myntra — spreading it out looks far more like a person than 8 parallel calls.
const PAID_TOTAL_CONCURRENCY = 3;

// The ₹ total actually paid out — deliberately NOT part of
// fetchSpfTicketCounts() above, and NOT summed from `meta.finalAmount`
// (tried that first, verified live it's wrong on two counts: it's not on
// the getTickets list rows at all — a real PAYMENT_COMPLETED row has no
// `meta` field — AND even on the per-claim fetchNewClaim response,
// `meta.finalAmount` is the PRODUCT'S SELLING PRICE, not the payout. The
// real amount Myntra actually pays the seller is the claim's own top-level
// `compensationAmount` field (tied to a real bank UTR reference on the same
// claim, and roughly tracking `cogs` — consistently lower than
// `finalAmount`, confirmed across multiple real paid tickets). So getting
// the real total costs one extra Myntra call PER PAID TICKET (querying its
// claim detail, same endpoint fetchSpfClaims/fetchClaimTrackingByReturnId
// use), run with limited concurrency like resolveTrackingIdsForTickets
// below — too heavy to run on every page load, only called from
// POST /api/spf-status/verify when the Paid card is actually revealed.
//
// ~15% of PAYMENT_COMPLETED tickets come back from getTickets with
// `returnId: null` (verified live) — fetchNewClaim also accepts a ticket's
// `orderId` and returns that same ticket's claim, so it's used as a
// fallback lookup key rather than silently dropping those tickets from the
// total. Only a claim whose own `ticketId` matches the ticket is accepted —
// never "the first row" — so one ticket's payout can't be counted against
// another's; if the returnId lookup doesn't include this ticket, the
// orderId lookup is tried before giving up.
//
// Returns every paid claim's details, not just the sum — lib/spfPaid.js
// uses them to split the total into fake / wrong / etc. Tickets whose claim
// couldn't be fetched are returned in `failed` (with why) rather than
// silently left out, so the page can say the total is incomplete. A
// session-expired / 401 / 403 error aborts the whole thing instead of being
// swallowed per ticket — otherwise an expired session would just read ₹0.
//
// Options (both optional, lib/spfCache.js): `tickets` = an already-loaded
// ticket list; `claimStore` = { get(ticketIds) -> Map, save(claims) } of
// already-resolved paid claims — a paid claim never changes, so only paid
// tickets not in the store cost a Myntra call.
async function fetchSpfPaidClaims(headers, { tickets = null, claimStore = null } = {}) {
  if (!tickets) tickets = await fetchSpfTickets(headers);
  const paid = tickets.filter((t) => t.status === 'PAYMENT_COMPLETED');
  const known = claimStore ? await claimStore.get(paid.map((t) => String(t.ticketId))) : new Map();
  const claims = paid.filter((t) => known.has(String(t.ticketId))).map((t) => known.get(String(t.ticketId)));
  const queue = paid.filter((t) => !known.has(String(t.ticketId)));
  const fresh = [];
  const failed = [];
  let authError = null;

  async function findClaim(ticket) {
    const lookupIds = [...new Set([ticket.returnId, ticket.orderId].filter((v) => v != null).map(String))];
    for (const id of lookupIds) {
      const res = await myntraGet(spfClaimByIdUrl(id), headers);
      throwIfSoftSessionExpired(res.data);
      const rows = (res.data && res.data.data) || [];
      const claim = rows.find((c) => c.ticketId === ticket.ticketId);
      if (claim) return claim;
    }
    return null;
  }

  async function worker() {
    while (queue.length && !authError) {
      const ticket = queue.shift();
      const base = { ticketId: ticket.ticketId, orderId: ticket.orderId, issueCategory: ticket.issueCategory };
      if (ticket.returnId == null && ticket.orderId == null) {
        failed.push({ ...base, reason: 'no returnId or orderId to look it up by' });
        continue;
      }
      try {
        const claim = await findClaim(ticket);
        if (!claim) {
          failed.push({ ...base, reason: 'claim not found' });
          continue;
        }
        const amount = claim.compensationAmount != null ? Number(claim.compensationAmount) : NaN;
        if (!Number.isFinite(amount)) {
          failed.push({ ...base, reason: 'no compensationAmount on the claim' });
          continue;
        }
        let meta = {};
        try {
          meta = claim.meta ? JSON.parse(claim.meta) : {};
        } catch {
          // unparseable meta just means no return tracking id to match on
        }
        fresh.push({
          ...base,
          amount,
          issueCategory: claim.issueCategory || ticket.issueCategory,
          skuId: claim.skuId ?? ticket.skuId ?? null,
          returnTrackingId: meta.returnTrackingId || null,
          originalTrackingId: claim.trackingId || null,
        });
      } catch (err) {
        if (isSessionRejected(err)) {
          authError = err;
          return;
        }
        failed.push({ ...base, reason: err.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(PAID_TOTAL_CONCURRENCY, queue.length || 1) }, worker));
  // Claims already fetched are kept even if the session died part-way — they
  // never change, so the next reveal doesn't pay for them again.
  if (claimStore) await claimStore.save(fresh);
  if (authError) throw authError;
  claims.push(...fresh);
  return { paidTicketCount: paid.length, claims, failed, fetchedCount: fresh.length + failed.length };
}

// Just the ₹ total, summed in paise so floating-point drift can't creep in.
async function fetchSpfPaidTotal(headers) {
  const { paidTicketCount, claims, failed } = await fetchSpfPaidClaims(headers);
  const paise = claims.reduce((sum, c) => sum + Math.round(c.amount * 100), 0);
  return { paidTotalAmount: paise / 100, paidTicketCount, failedCount: failed.length };
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
  const res = await myntraGet(spfClaimByIdUrl(returnId), headers);
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
const TRACKING_LOOKUP_CONCURRENCY = 3;

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

function packedOrderSearchUrl(trackingNumber, searchOn = 'trackingNumber') {
  return (
    `https://partnersapi.myntrainfo.com/api/mdirect/orders/searchPostPackedOrder/${WAREHOUSE_ID}` +
    `?searchOn=${searchOn}&id=${encodeURIComponent(trackingNumber)}`
  );
}

/**
 * "Scan packed/picked" lookup — everything about one outbound packet from a
 * scanned label: status (PACKED / PICKED / SHIPPED…), packed/picked/shipped
 * times, and each line item's photo, name, seller SKU, size and color.
 * Same searchPostPackedOrder endpoint the return resolver's step 2 uses —
 * it returns full line-item detail, unlike the getPostPackedOrders list
 * (which only has skuId per item).
 *
 * Verified live against this endpoint:
 * - The id MUST be uppercase — a lowercased tracking number comes back as
 *   an HTTP 500, same as a nonexistent one. So input is normalised first.
 * - An unknown id (or a RETURN label like MYSR…, which isn't an outbound
 *   packet) is an HTTP 500 "Error in APIGATEWAY", not an empty list — so a
 *   500 is reported as "not found" (returns null) rather than a crash.
 * - An all-digits code is the packet id (`storePacketId`, also printed on
 *   some labels) — searched with `searchOn=storePacketId` instead.
 *
 * Returns null when nothing is found; throws on session expiry / 401 / 403
 * so the caller can say the session needs refreshing.
 */
async function lookupPackedShipment(rawId, headers) {
  const id = String(rawId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!id) return null;
  const searchOn = /^\d+$/.test(id) ? 'storePacketId' : 'trackingNumber';

  let res;
  try {
    res = await myntraGet(packedOrderSearchUrl(id, searchOn), headers);
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 500 || status === 404) return null;
    throw err;
  }
  throwIfSoftSessionExpired(res.data);
  const rows = (res.data && res.data.data) || [];
  const packet =
    rows.find((r) => (searchOn === 'trackingNumber' ? r.trackingNumber : String(r.storePacketId)) === id) || rows[0];
  if (!packet) return null;

  const at = (ms) => (ms ? { ms, text: formatIST(ms) } : null);
  return {
    searchedId: id,
    trackingNumber: packet.trackingNumber || null,
    storePacketId: packet.storePacketId != null ? String(packet.storePacketId) : null,
    status: packet.packetStatus || null,
    type: packet.type || null,
    quantity: packet.quantity ?? null,
    packedOn: at(packet.packedOn),
    pickedOn: at(packet.pickedOn),
    shippedOn: at(packet.shippedOn),
    packBy: at(packet.packByTime),
    pickBy: at(packet.pickByTime),
    items: (packet.lineItems || []).map((li) => ({
      skuId: li.skuId ?? null,
      sellerSkuCode: li.sellerSkuCode || null,
      myntraSku: li.myntraSku || null,
      productName: li.productDisplayName || null,
      brand: li.brand || null,
      articleType: li.articleType || null,
      size: li.size || null,
      color: li.color || null,
      quantity: li.quantity ?? 1,
      mrp: li.mrp ?? null,
      finalAmount: li.finalAmount ?? null,
      image: pickImageUrl(li),
    })),
  };
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
  const res = await myntraGet(spfClaimUrl(returnTrackingId), headers);
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
      returnType: myntraReturnType(claim),
      // Myntra's order number as its returns/SPF pages show it (e.g.
      // 100289743725) — what claims and support need. Not the same number as
      // the new-order alert's M-Direct id (e.g. 6028789826); Myntra uses both.
      orderId: claim.orderId != null ? String(claim.orderId) : null,
    };
  });
}

// Customer return vs RTO, from the same claim record (no extra call).
// Verified live 2026-09-23 against all 512 Myntra returns in stock-manager:
// every customer return (scanned by its MYSR/MYER return label) has a return
// date/reason and orderStatus "C"; every RTO (the ORIGINAL MYSC/MYSP/MYEC/MYEP
// label came back) has no return date and orderStatus "RTO" — or "F" (96 of
// them: never delivered, came back on the original label, i.e. also an RTO;
// Myntra doesn't document the code). Anything else is UNKNOWN.
function myntraReturnType(claim) {
  if (claim.returnCreatedDate || claim.returnReason) return 'CUSTOMER';
  if (claim.orderStatus === 'RTO' || claim.orderStatus === 'F') return 'RTO';
  return 'UNKNOWN';
}

// Step 2: the ORIGINAL shipment's own packed-order record, by ITS tracking
// id (from step 1) — this is where the real seller SKU + size actually live,
// not in the SPF claim itself. Returns EVERY line item on that shipment (a
// multi-item order packs as ONE order record with multiple `lineItems`, each
// with its own `skuId`) — the caller matches the right one by `skuId`,
// never just `lineItems[0]`.
async function fetchPackedOrderByTracking(trackingNumber, headers) {
  const res = await myntraGet(packedOrderSearchUrl(trackingNumber), headers);
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
    try {
      lineItemsByTracking.set(tid, await fetchPackedOrderByTracking(tid, headers));
    } catch (err) {
      // Myntra answers an unknown / other-warehouse shipment with HTTP 500
      // (see lookupPackedShipment). That only means the SKU can't be worked
      // out — the claim itself (photo, reason, type) is still shown, with
      // "no SKU", instead of the whole lookup failing with a raw 500.
      const status = err.response && err.response.status;
      if (status !== 500 && status !== 404) throw err;
      lineItemsByTracking.set(tid, []);
    }
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
      returnType: claim.returnType,
      orderId: claim.orderId,
      productName: claim.productName,
      sku: matched ? matched.sellerSkuCode : null,
      size: matched ? matched.size : null,
      color: matched ? matched.color : null,
    };
  });
}

function formatItemCaption(item, stockLine = '', category = '') {
  const categoryLine = category ? `Category: ${escapeHtml(category)}\n` : '';
  return (
    categoryLine +
    `SKU: <code>${escapeHtml(item.sellerSkuCode || item.skuCode)}</code>\n` +
    `Size: ${escapeHtml(item.size || '?')}${item.color ? ` | Color: ${escapeHtml(item.color)}` : ''}\n` +
    `Qty: ${escapeHtml(item.qty ?? 1)}\n` +
    stockLine
  ).trim();
}

module.exports = {
  isSessionRejected,
  describeMyntraError,
  fetchOpenOrders,
  fetchCancelledOrders,
  fetchOrderItems,
  fetchOrderRows,
  groupOrderRows,
  fetchOtc,
  fetchPackedCount,
  fetchPackedPackets,
  fetchSpfTickets,
  fetchSpfTicketCounts,
  fetchSpfPaidClaims,
  fetchSpfPaidTotal,
  resolveTrackingIdsForTickets,
  fetchSpfClaims,
  fetchPackedOrderByTracking,
  lookupPackedShipment,
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
