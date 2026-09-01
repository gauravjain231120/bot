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

function pickAmazonImage(item) {
  return item.imageUrl ? item.imageUrl.replace(/^http:\/\//, 'https://') : null;
}

// Amazon's orderDate is epoch seconds (with fractional milliseconds), not epoch ms.
function amazonOrderDateMs(order) {
  return order.orderDate ? Math.round(order.orderDate * 1000) : null;
}

function formatAmazonAlert(order) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const itemCount = (order.orderItems || []).length;
  return (
    `📦 <b>New Amazon order</b>\n` +
    `Order ID: <code>${order.amazonOrderId}</code>\n` +
    `Items: ${itemCount}\n` +
    `Placed: ${orderDate}`
  );
}

function formatAmazonItemCaption(order, item) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  return (
    `📦 <b>New Amazon order</b>\n` +
    `Order ID: <code>${order.amazonOrderId}</code>\n` +
    `SKU: <code>${item.sellerSku || '?'}</code>\n` +
    `${item.productName || item.extendedTitle || ''}\n` +
    `Qty: ${item.quantityOrdered ?? 1}\n` +
    `Placed: ${orderDate}`
  );
}

module.exports = {
  fetchUnshippedOrders,
  pickAmazonImage,
  amazonOrderDateMs,
  formatAmazonAlert,
  formatAmazonItemCaption,
};
