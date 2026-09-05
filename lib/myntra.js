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
    `❌ <b>Order cancelled</b>\n` +
    `Order ID: <code>${order.orderId}</code>\n` +
    `Qty: ${order.quantity ?? '?'}\n` +
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
async function fetchOrderItems(orderId, headers) {
  const url = `https://partnersapi.myntrainfo.com/api/mdirect/orders/${orderId}/open-order-details/${WAREHOUSE_ID}`;
  const res = await axios.get(url, { headers });
  throwIfSoftSessionExpired(res.data);
  const rows = Array.isArray(res.data && res.data.data) ? res.data.data : [];

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
  pickImageUrl,
  formatAlert,
  formatOrderHeader,
  formatItemCaption,
  formatCancelAlert,
  formatIST,
  WAREHOUSE_ID,
};
