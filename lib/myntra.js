const axios = require('axios');
const { formatIST } = require('./dates');

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

async function fetchOrderItems(orderId, headers) {
  const url = `https://partnersapi.myntrainfo.com/api/mdirect/orders/${orderId}/open-order-details/${WAREHOUSE_ID}`;
  const res = await axios.get(url, { headers });
  return Array.isArray(res.data && res.data.data) ? res.data.data : [];
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
  const shipBy = formatIST(order.packByTime);
  return (
    `🛒 <b>New Myntra order</b>\n` +
    `Order ID: <code>${order.orderId}</code>\n` +
    `Qty: ${order.quantity ?? '?'}\n` +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

function formatItemCaption(order, item, stockLine = '') {
  const orderDate = formatIST(order.orderDate);
  const shipBy = formatIST(order.packByTime);
  return (
    `🛒 <b>New Myntra order</b>\n` +
    `Order ID: <code>${order.orderId}</code>\n` +
    `SKU: <code>${item.sellerSkuCode || item.skuCode}</code>\n` +
    `${item.productDisplayName || ''}\n` +
    `Size: ${item.size || '?'}${item.color ? ` | Color: ${item.color}` : ''}\n` +
    stockLine +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

module.exports = {
  fetchOpenOrders,
  fetchCancelledOrders,
  fetchOrderItems,
  pickImageUrl,
  formatAlert,
  formatItemCaption,
  formatCancelAlert,
  formatIST,
  WAREHOUSE_ID,
};
