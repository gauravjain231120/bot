const axios = require('axios');
const { formatIST } = require('./dates');

// Amazon Seller Central has no public order-alert API either — this replays the
// same internal request the orders dashboard itself makes. Unlike Myntra, this
// endpoint already returns full item detail (image, SKU, title) in one call.
function searchUrl(program) {
  const params = new URLSearchParams({
    limit: '15',
    offset: '0',
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

// Merchant-fulfilled orders come through either Amazon's Easy Ship program or
// self-ship — check both so nothing is missed regardless of which is used per order.
async function fetchUnshippedOrders(headers) {
  const programs = ['easyship', 'selfship'];
  const results = await Promise.all(
    programs.map((program) => axios.get(searchUrl(program), { headers }).then((res) => res.data.orders || []))
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
  pickAmazonImage,
  amazonOrderDateMs,
  amazonShipByDateMs,
  extractVariant,
  groupAmazonItemsBySku,
  formatAmazonAlert,
  formatAmazonOrderHeader,
  formatAmazonItemCaption,
};
