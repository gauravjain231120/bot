const axios = require('axios');
const { formatIST } = require('./dates');
const { persistAmazonCookies } = require('./myntraCookies');

// Amazon's fraud/bot detection occasionally blocks one specific query shape
// with a 403 while the exact same session succeeds on a different one seconds
// later (observed: cancellation search 403s while the unshipped search on the
// same session works fine) — a real session expiry would fail everything, not
// just one query. A short retry absorbs that kind of one-off block instead of
// surfacing it as an error and waiting a full cycle to recover.
//
// Not retried: a real sign-out — 401, or 403 with Amazon's own body
// `{"reason":"sign_in"}` (verified live 2026-09-23). Retrying those only
// burned 2 extra calls (and ~8s) on every check for the whole outage.
//
// Every successful response also refreshes the stored session's cookies:
// Amazon re-issues `session-token` on each call, and the bot used to throw
// that away (lib/myntraCookies.js persistAmazonCookies).
function isSignIn(err) {
  const r = err && err.response;
  return !!(r && (r.status === 401 || (r.status === 403 && r.data && r.data.reason === 'sign_in')));
}

async function getWithRetry(url, headers, retries = 2, delayMs = 4000) {
  try {
    const res = await axios.get(url, { headers });
    await persistAmazonCookies(headers, res);
    return res;
  } catch (err) {
    const status = err.response && err.response.status;
    if (isSignIn(err)) throw err;
    if (retries > 0 && (status === 403 || status === 429 || (status && status >= 500))) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return getWithRetry(url, headers, retries - 1, delayMs);
    }
    throw err;
  }
}

// Amazon Seller Central has no public order-alert API either — this replays the
// same internal request the orders dashboard itself makes. Unlike Myntra, this
// endpoint already returns full item detail (image, SKU, title) in one call.
function searchUrl(program, offset, limit) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sort: 'ship_by_asc',
    'date-range': 'last-90',
    fulfillmentType: 'mfn',
    orderStatus: 'unshipped',
    program,
    shipByDate: 'all',
    forceOrdersTableRefreshTrigger: 'false',
  });
  return `https://sellercentral.amazon.in/orders-api/search?${params.toString()}`;
}

// Same search endpoint, just orderStatus=canceled instead of unshipped —
// Amazon's own "Canceled orders" tab uses this identical request shape.
function cancelledSearchUrl(program, offset, limit) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sort: 'ship_by_desc',
    'date-range': 'last-90',
    fulfillmentType: 'mfn',
    orderStatus: 'canceled',
    program,
    forceOrdersTableRefreshTrigger: 'false',
  });
  return `https://sellercentral.amazon.in/orders-api/search?${params.toString()}`;
}

// A 200 whose body isn't the orders JSON is Amazon's sign-in page. Without
// this check it read as "0 orders" — no error, no session-expired alert, new
// orders silently missed. Thrown as a 401 so every caller's existing
// session-expired handling covers it.
function ordersFrom(res) {
  if (!res || !res.data || typeof res.data !== 'object' || !Array.isArray(res.data.orders)) {
    const err = new Error('Amazon returned a sign-in page instead of orders');
    err.response = { status: 401, data: res && res.data };
    throw err;
  }
  return res.data.orders;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20; // safety cap (≤2000 orders) against any pagination-math edge case

// A hardcoded limit=15 with no pagination silently dropped every order past
// the 15th once a seller had more than that many open at once — confirmed
// live: the same session that returned 15 orders at limit=15 returned all
// 18 real ones at limit=100, with a `total` field in the response matching
// exactly. This is very likely what caused the earlier "orders invisible to
// the poller" mystery. Paginate off that `total` field instead of trusting
// one page to contain everything, however large it currently looks.
async function fetchAllPages(urlBuilder, headers) {
  let offset = 0;
  let all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await getWithRetry(urlBuilder(offset, PAGE_SIZE), headers);
    const orders = ordersFrom(res);
    all = all.concat(orders);
    const total = typeof res.data.total === 'number' ? res.data.total : all.length;
    offset += orders.length;
    if (orders.length === 0 || offset >= total) break;
  }
  return all;
}

// Cheapest possible "does this session work?" check — ONE search request
// with limit=1 (instead of fetchUnshippedOrders' 2 programs x every page).
// Used to test a synced session before the bot switches to it.
async function probeAmazonSession(headers) {
  ordersFrom(await getWithRetry(searchUrl('easyship', 0, 1), headers, 1, 2000));
  return true;
}

// Easy Ship only. This account doesn't use self-ship (0 orders in 365 days
// vs 704 Easy Ship, verified 2026-09-23), and searching it on every check was
// half of all Amazon calls — removed on the seller's instruction. If
// self-ship is ever used, add 'selfship' back here: every fetch below takes
// its programs from this list.
const ALL_PROGRAMS = ['easyship'];

// { easyship: [...] } — one entry per program searched (see ALL_PROGRAMS).
async function fetchUnshippedByProgram(headers, programs = ALL_PROGRAMS) {
  const results = await Promise.all(
    programs.map((program) => fetchAllPages((offset, limit) => searchUrl(program, offset, limit), headers))
  );
  return Object.fromEntries(programs.map((p, i) => [p, results[i]]));
}

async function fetchUnshippedOrders(headers, programs = ALL_PROGRAMS) {
  return Object.values(await fetchUnshippedByProgram(headers, programs)).flat();
}

// Deliberately NOT paginated like fetchUnshippedOrders — even though this
// endpoint is bounded to the last 90 days, that's still enough history to
// contain far more than a handful of old cancellations the poller never
// marked seen (confirmed: this one call alone surfaced ~95, all flooding out
// as individual alerts in one go, for the same reason as Myntra's — see
// fetchCancelledOrders in lib/myntra.js). A single bounded page is enough
// headroom for "anything cancelled since the last ~30-minute check."
async function fetchCancelledByProgram(headers, programs = ALL_PROGRAMS) {
  const results = await Promise.all(
    programs.map((program) => getWithRetry(cancelledSearchUrl(program, 0, 50), headers).then(ordersFrom))
  );
  return Object.fromEntries(programs.map((p, i) => [p, results[i]]));
}

async function fetchCancelledOrders(headers, programs = ALL_PROGRAMS) {
  return Object.values(await fetchCancelledByProgram(headers, programs)).flat();
}

// Amazon's search response returns small thumbnails (e.g. "..._SR135,135_.jpg") —
// swap the size modifier for a much larger one. Amazon's CDN clamps this to
// whatever the listing's master image actually is (currently ~373x500 across this
// catalog) — asking for more costs nothing and helps automatically if any listing
// later gets a higher-res image uploaded in Seller Central.
function pickAmazonImage(item) {
  if (!item.imageUrl) return null;
  const url = item.imageUrl.replace(/^http:\/\//, 'https://');
  return url.replace(/\._[A-Za-z0-9,_]+_\.(\w+)$/, '._SL1500_.$1');
}

// Amazon's date fields are epoch seconds (with fractional milliseconds), not epoch ms.
function amazonOrderDateMs(order) {
  return order.orderDate ? Math.round(order.orderDate * 1000) : null;
}

function amazonShipByDateMs(order) {
  return order.latestShipDate ? Math.round(order.latestShipDate * 1000) : null;
}

// Sums quantities for any line items sharing the same SKU within one order
// (rare, but possible) so the rest of the pipeline sees one row per SKU with
// its true total quantity, instead of double-submitting the same SKU+order.
function groupAmazonItemsBySku(orderItems) {
  const bySku = new Map();
  for (const item of orderItems || []) {
    const sku = item.sellerSku;
    const qty = item.quantityOrdered || 1;
    const existing = bySku.get(sku);
    if (existing) existing.qty += qty;
    else bySku.set(sku, { ...item, qty });
  }
  return [...bySku.values()];
}

// Same idea as groupAmazonItemsBySku but for the cancelled-orders search,
// which reports quantityCanceled rather than quantityOrdered.
function groupAmazonCancelledItemsBySku(orderItems) {
  const bySku = new Map();
  for (const item of orderItems || []) {
    const sku = item.sellerSku;
    const qty = item.quantityCanceled || 1;
    const existing = bySku.get(sku);
    if (existing) existing.qty += qty;
    else bySku.set(sku, { ...item, qty });
  }
  return [...bySku.values()];
}

// Amazon's order-search response has no structured size/color fields — unlike
// Myntra, they're only present inside the title text (e.g. "... (Rose Red) - XXL"
// or "... - Grey - XS") and, for size, often as the SKU's last segment too.
const SIZE_TOKENS = ['XXXL', '3XL', 'XXL', 'XL', 'XS', 'L', 'M', 'S'];
const SIZE_RE = new RegExp(`-\\s*(${SIZE_TOKENS.join('|')})\\s*$`, 'i');

function sizeFromSku(sku) {
  if (!sku) return null;
  const last = sku.split('-').pop().toUpperCase();
  return SIZE_TOKENS.includes(last) ? last : null;
}

function extractVariant(item) {
  const title = (item.productName || item.extendedTitle || '').trim();
  let remaining = title;
  let size = null;

  const sizeMatch = remaining.match(SIZE_RE);
  if (sizeMatch) {
    size = sizeMatch[1].toUpperCase();
    remaining = remaining.slice(0, sizeMatch.index).trim();
  } else {
    size = sizeFromSku(item.sellerSku);
  }

  let color = null;
  const parenMatch = remaining.match(/\(([^()]+)\)\s*$/);
  if (parenMatch) {
    color = parenMatch[1].trim();
  } else {
    const dashMatch = remaining.match(/-\s*([A-Za-z ]{2,24})\s*$/);
    if (dashMatch) color = dashMatch[1].trim();
  }

  return { size, color };
}

function formatAmazonCancelAlert(order) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const qty = (order.orderItems || []).reduce((sum, item) => sum + (item.quantityCanceled || 0), 0);
  return (
    `❌❌❌❌ <b>Amazon order cancelled</b>\n` +
    `Order ID: <code>${order.amazonOrderId}</code>\n` +
    `Qty: ${qty || '?'}\n` +
    `Placed: ${orderDate}`
  );
}

// Header for the richer cancel alert (photo + category) — the cancelled-orders
// search already returns full item detail inline, unlike Myntra, so no extra
// fetch is needed before building this. The quadruple ❌ is deliberate — a
// packer skimming a photo album needs this to read as "STOP, do not ship" at
// a glance, not blend in with a normal order alert.
function formatAmazonCancelHeader(order, itemCount = 1) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const multiLine = itemCount > 1 ? `🔀 <b>MULTI ORDER</b> (${itemCount} items)\n` : '';
  return (
    `❌❌❌❌ <b>Amazon order cancelled</b>\n` +
    multiLine +
    `Order ID: <code>${order.amazonOrderId}</code>\n` +
    `Placed: ${orderDate}`
  );
}

function formatAmazonAlert(order) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const shipBy = formatIST(amazonShipByDateMs(order));
  const itemCount = (order.orderItems || []).length;
  return (
    `📦 <b>New Amazon order</b>\n` +
    `Order ID: <code>${order.amazonOrderId}</code>\n` +
    `Items: ${itemCount}\n` +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

// Sent once per order, ahead of one caption per unique SKU — so a multi-item
// order reads as one grouped alert instead of repeating Order ID/Placed/Ship by
// on every item.
function formatAmazonOrderHeader(order, itemCount = 1) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const shipBy = formatIST(amazonShipByDateMs(order));
  const multiLine = itemCount > 1 ? `🔀 <b>MULTI ORDER</b> (${itemCount} items)\n` : '';
  return (
    `📦 <b>New Amazon order</b>\n` +
    multiLine +
    `Order ID: <code>${order.amazonOrderId}</code>\n` +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

function formatAmazonItemCaption(item, stockLine = '', category = '') {
  const { size, color } = extractVariant(item);
  const variantLine = size || color ? `Size: ${size || '?'}${color ? ` | Color: ${color}` : ''}\n` : '';
  const categoryLine = category ? `Category: ${category}\n` : '';
  return (
    categoryLine +
    `SKU: <code>${item.sellerSku || '?'}</code>\n` +
    variantLine +
    `Qty: ${item.qty ?? 1}\n` +
    stockLine
  ).trim();
}

module.exports = {
  fetchUnshippedOrders,
  fetchUnshippedByProgram,
  fetchCancelledByProgram,
  probeAmazonSession,
  fetchCancelledOrders,
  pickAmazonImage,
  amazonOrderDateMs,
  amazonShipByDateMs,
  extractVariant,
  groupAmazonItemsBySku,
  groupAmazonCancelledItemsBySku,
  formatAmazonAlert,
  formatAmazonOrderHeader,
  formatAmazonItemCaption,
  formatAmazonCancelAlert,
  formatAmazonCancelHeader,
};
