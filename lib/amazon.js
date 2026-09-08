const axios = require('axios');
const { formatIST } = require('./dates');

// Amazon's fraud/bot detection occasionally blocks one specific query shape
// with a 403 while the exact same session succeeds on a different one seconds
// later (observed: cancellation search 403s while the unshipped search on the
// same session works fine) — a real session expiry would fail everything, not
// just one query. A short retry absorbs that kind of one-off block instead of
// surfacing it as an error and waiting a full cycle to recover.
async function getWithRetry(url, headers, retries = 2, delayMs = 4000) {
  try {
    return await axios.get(url, { headers });
  } catch (err) {
    const status = err.response && err.response.status;
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
    const orders = res.data.orders || [];
    all = all.concat(orders);
    const total = typeof res.data.total === 'number' ? res.data.total : all.length;
    offset += orders.length;
    if (orders.length === 0 || offset >= total) break;
  }
  return all;
}

// Merchant-fulfilled orders come through either Amazon's Easy Ship program or
// self-ship — check both so nothing is missed regardless of which is used per order.
async function fetchUnshippedOrders(headers) {
  const programs = ['easyship', 'selfship'];
  const results = await Promise.all(
    programs.map((program) => fetchAllPages((offset, limit) => searchUrl(program, offset, limit), headers))
  );
  return results.flat();
}

// Deliberately NOT paginated like fetchUnshippedOrders — even though this
// endpoint is bounded to the last 90 days, that's still enough history to
// contain far more than a handful of old cancellations the poller never
// marked seen (confirmed: this one call alone surfaced ~95, all flooding out
// as individual alerts in one go, for the same reason as Myntra's — see
// fetchCancelledOrders in lib/myntra.js). A single bounded page is enough
// headroom for "anything cancelled since the last ~30-minute check."
async function fetchCancelledOrders(headers) {
  const programs = ['easyship', 'selfship'];
  const results = await Promise.all(
    programs.map((program) => getWithRetry(cancelledSearchUrl(program, 0, 50), headers).then((res) => res.data.orders || []))
  );
  return results.flat();
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
