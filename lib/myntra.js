const axios = require('axios');
const { formatIST, formatISTDate, myntraShipByDateMs } = require('./dates');

const WAREHOUSE_ID = process.env.WAREHOUSE_ID || '89623';

function openOrdersUrl() {
  return (
    'https://partnersapi.myntrainfo.com/api/mdirect/orders/v2/open' +
    `?status=CREATED&fetchSize=15&start=0&sortBy=id&sortOrder=ASC&warehouseId=${WAREHOUSE_ID}` +
    '&sellerProcessingTimeOrderStatus=PROCESSABLE&priority=false&useDispatchWarehouseCutoff=true'
  );
}

function cancelledOrdersUrl() {
  return (
    'https://partnersapi.myntrainfo.com/api/mdirect/orders/cancel' +
    `?fetchSize=15&start=0&sortBy=lastModifiedOn&sortOrder=DESC&warehouseId=${WAREHOUSE_ID}`
  );
}

async function fetchCancelledOrders(headers) {
  const res = await axios.get(cancelledOrdersUrl(), { headers });
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
  const res = await axios.get(openOrdersUrl(), { headers });
  return extractOrders(res.data);
}

// Myntra returns one row per physical unit (a qty-2 order of one variant comes
// back as two identical rows) — group by SKU so the rest of the pipeline deals
// in "this SKU, this many units" instead of duplicate per-unit rows.
async function fetchOrderItems(orderId, headers) {
  const url = `https://partnersapi.myntrainfo.com/api/mdirect/orders/${orderId}/open-order-details/${WAREHOUSE_ID}`;
  const res = await axios.get(url, { headers });
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
function formatOrderHeader(order) {
  const orderDate = formatIST(order.orderDate);
  const shipBy = formatISTDate(myntraShipByDateMs(order.orderDate));
  return (
    `🛒 <b>New Myntra order</b>\n` +
    `Order ID: <code>${order.orderId}</code>\n` +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

function formatItemCaption(item, stockLine = '') {
  return (
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
