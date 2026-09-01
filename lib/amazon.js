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

function formatAmazonItemCaption(order, item) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const shipBy = formatIST(amazonShipByDateMs(order));
  return (
    `📦 <b>New Amazon order</b>\n` +
    `Order ID: <code>${order.amazonOrderId}</code>\n` +
    `SKU: <code>${item.sellerSku || '?'}</code>\n` +
    `${item.productName || item.extendedTitle || ''}\n` +
    `Qty: ${item.quantityOrdered ?? 1}\n` +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

module.exports = {
  fetchUnshippedOrders,
  pickAmazonImage,
  amazonOrderDateMs,
  amazonShipByDateMs,
  formatAmazonAlert,
  formatAmazonItemCaption,
};
