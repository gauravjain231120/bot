const axios = require('axios');

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
  const orderDate = order.orderDate ? new Date(order.orderDate).toLocaleString() : 'unknown';
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

function pickImageUrl(item) {
  const images = item.images || [];
  const chosen = images.find((im) => im.imageType === 'default') || images[0];
  if (!chosen) return null;
  const url = (chosen.resolutions && chosen.resolutions['360X480']) || chosen.path;
  return url ? url.replace(/^http:\/\//, 'https://') : null;
}

function formatAlert(order) {
  const orderDate = order.orderDate ? new Date(order.orderDate).toLocaleString() : 'unknown';
  return (
    `🛒 <b>New Myntra order</b>\n` +
    `Order ID: <code>${order.orderId}</code>\n` +
    `Qty: ${order.quantity ?? '?'}\n` +
    `Placed: ${orderDate}`
  );
}

function formatItemCaption(order, item) {
  const orderDate = order.orderDate ? new Date(order.orderDate).toLocaleString() : 'unknown';
  return (
    `🛒 <b>New Myntra order</b>\n` +
    `Order ID: <code>${order.orderId}</code>\n` +
    `SKU: <code>${item.sellerSkuCode || item.skuCode}</code>\n` +
    `${item.productDisplayName || ''}\n` +
    `Size: ${item.size || '?'}${item.color ? ` | Color: ${item.color}` : ''}\n` +
    `Placed: ${orderDate}`
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
  WAREHOUSE_ID,
};
