const axios = require('axios');
const { formatIST } = require('./dates');
const { pickAmazonImage, extractVariant } = require('./amazon');

// Lookups behind the dashboard's "Amazon Pack" and "Amazon Return" scan
// pages (app/amazon-packed, app/amazon-returns). Same replay-the-Seller-
// Central-request approach as lib/amazon.js, same saved session
// (settings/_id:'session_amazon'). Read-only — nothing here writes to Amazon.
//
// Verified live (2026-09-23) against this account:
// - Orders search by tracking number needs `qt=tracking-id` — without it the
//   `q` term is silently ignored and EVERY order comes back. With it, an
//   unknown number is a clean `total: 0`.
// - `qt=order-id` is NOT honoured the same way (returns everything), so an
//   order id goes straight to `orders-api/order/{id}` instead.
// - Returns search: `searchBy=CarrierTrackingId` and `searchBy=OrderId` both
//   work; an unknown id is `returnRequests: []`.
// - Expired session = HTTP 403 with body `{"reason":"sign_in"}`. A bare 403 can
//   also be Amazon's one-off bot block (see lib/amazon.js getWithRetry), so
//   only the sign_in one is treated as "session expired".

const MARKETPLACE_ID = 'A21TJRUUN4KGV';
const RETURN_STATES = ['Approved', 'PendingLabel', 'PendingRefund', 'PendingApproval', 'Completed', 'Closed', 'Approving'];

function sessionExpiredError() {
  const err = new Error('Amazon session expired — refresh it on the Sessions page.');
  err.sessionExpired = true;
  return err;
}

async function amazonGet(url, headers) {
  for (let attempt = 0; ; attempt++) {
    const res = await axios.get(url, { headers, validateStatus: () => true });
    if (res.status === 200 && res.data && typeof res.data === 'object') return res.data;
    if (res.data && res.data.reason === 'sign_in') throw sessionExpiredError();
    if (res.status === 401) throw sessionExpiredError();
    const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    if (retryable && attempt < 1) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    // A 200 that isn't JSON is Amazon's sign-in HTML page.
    if (res.status === 200) throw sessionExpiredError();
    const err = new Error(`Amazon returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

// Amazon order ids are always 3-7-7 digits. Accepts it with or without dashes
// (a camera read or a barcode may drop them) and puts them back.
function normalizeOrderId(raw) {
  const m = String(raw || '').match(/(\d{3})[\s\-–—]*(\d{7})[\s\-–—]*(\d{7})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function normalizeTracking(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
}

// Amazon dates are epoch SECONDS (with a fraction) on the orders API but
// epoch MILLISECONDS on the returns API — callers say which.
const at = (value, unit) => {
  if (value == null) return null;
  const ms = unit === 's' ? Math.round(value * 1000) : value;
  return { ms, text: formatIST(ms) };
};

function sellerSkuImage(url) {
  return pickAmazonImage({ imageUrl: url });
}

// ---- Amazon Pack ----

async function findOrderIdByTracking(tracking, headers) {
  const url =
    'https://sellercentral.amazon.in/orders-api/search?limit=15&offset=0&sort=ship_by_asc&date-range=last-365' +
    `&q=${encodeURIComponent(tracking)}&qt=tracking-id&forceOrdersTableRefreshTrigger=false`;
  const data = await amazonGet(url, headers);
  const orders = data.orders || [];
  return orders.map((o) => o.amazonOrderId).filter(Boolean);
}

async function fetchOrderDetail(orderId, headers) {
  let data;
  try {
    data = await amazonGet(`https://sellercentral.amazon.in/orders-api/order/${encodeURIComponent(orderId)}`, headers);
  } catch (err) {
    if (err.status === 404 || err.status === 400) return null;
    throw err;
  }
  return (data && data.order) || null;
}

function shapeOrder(order, scannedTracking) {
  const itemsById = new Map((order.orderItems || []).map((it) => [it.OrderItemId, it]));
  const toItem = (it) => {
    const full = itemsById.get(it.OrderItemId) || it;
    const { size, color } = extractVariant({ productName: full.Title, sellerSku: full.SellerSKU });
    return {
      sku: full.SellerSKU || null,
      title: full.Title || null,
      asin: full.ASIN || null,
      image: sellerSkuImage(full.ImageUrl),
      size,
      color,
      quantity: it.QuantityShipped || it.QuantityOrdered || full.QuantityOrdered || 1,
      price: full.ItemCost && full.ItemCost.UnitPrice ? full.ItemCost.UnitPrice.Amount : null,
    };
  };

  const packages = (order.packages || []).map((p) => ({
    trackingId: p.TrackingId || null,
    carrier: p.Carrier || null,
    shipDate: at(p.ShipDate, 's'),
    pickupStart: p.MssDetails ? at(p.MssDetails.PickupStartDate, 's') : null,
    pickupEnd: p.MssDetails ? at(p.MssDetails.PickupEndDate, 's') : null,
    scanned: !!scannedTracking && normalizeTracking(p.TrackingId) === scannedTracking,
    items: (p.PackageItems || []).map(toItem),
  }));

  return {
    orderId: order.amazonOrderId,
    status: (order.orderStatus && order.orderStatus.OrderStatus) || null,
    labelStatus: order.labelStatus || null,
    cod: !!order.cod,
    orderDate: at(order.purchaseDate, 's'),
    shipBy: at(order.latestShipDate, 's'),
    deliverBy: at(order.latestDeliveryDate, 's'),
    packages,
    // Every line on the order, for orders with no package yet (not shipped).
    items: packages.length ? [] : (order.orderItems || []).map(toItem),
  };
}

/**
 * mode 'tracking' (the label's barcode) or 'order' (the printed order id).
 * Returns { orders: [...] } — normally one; a tracking number that somehow
 * matches several orders returns them all rather than guessing.
 */
async function lookupAmazonPacked(mode, rawValue, headers) {
  if (mode === 'order') {
    const orderId = normalizeOrderId(rawValue);
    if (!orderId) return { error: 'That doesn\'t look like an Amazon order ID (###-#######-#######).', status: 400 };
    const order = await fetchOrderDetail(orderId, headers);
    if (!order) return { error: `No Amazon order found for ${orderId}.`, status: 404 };
    return { searched: orderId, orders: [shapeOrder(order, null)] };
  }

  const tracking = normalizeTracking(rawValue);
  if (!tracking) return { error: 'Scan or type a tracking number.', status: 400 };
  const orderIds = await findOrderIdByTracking(tracking, headers);
  if (!orderIds.length) {
    return { error: `No Amazon order found for tracking ${tracking} (searched the last 365 days).`, status: 404 };
  }
  const orders = [];
  for (const id of orderIds.slice(0, 5)) {
    const order = await fetchOrderDetail(id, headers);
    if (order) orders.push(shapeOrder(order, tracking));
  }
  if (!orders.length) return { error: `Found order ${orderIds[0]} but couldn't load its details.`, status: 502 };
  return { searched: tracking, orders };
}

// ---- Amazon Return ----

function returnsUrl(searchBy, term) {
  const states = RETURN_STATES.map((s) => `returnRequestStates=${s}`).join('&');
  return (
    'https://sellercentral.amazon.in/returns/api/return-requests?pagination.pageSize=25&sort.column=CREATED_DATE&sort.order=DESC' +
    `&searchTerm=${encodeURIComponent(term)}&searchBy=${searchBy}&marketplaceIds=${MARKETPLACE_ID}&${states}` +
    '&dateRange.selectedDateRange=365'
  );
}

const valueOf = (field) => (field && typeof field === 'object' ? field.value ?? null : field ?? null);

function shapeReturn(rr) {
  const trackingId = rr.labelInfo ? valueOf(rr.labelInfo.carrierTrackingId) : null;
  return {
    returnRequestId: rr.returnRequestId,
    orderId: rr.orderInfo ? valueOf(rr.orderInfo.orderId) : null,
    status: valueOf(rr.requestState),
    trackingId,
    carrier: rr.labelInfo ? rr.labelInfo.carrierName || null : null,
    exchange: (rr.badges || []).some((b) => b.id === 'EXCHANGE'),
    requestDate: at(rr.returnRequestDate, 'ms'),
    orderDate: at(rr.orderDate, 'ms'),
    closeDate: at(rr.closeDate, 'ms'),
    items: (rr.items || []).map((it) => {
      const sku = valueOf(it.merchantSKU);
      const title = valueOf(it.product);
      const { size, color } = extractVariant({ productName: title, sellerSku: sku });
      return {
        sku,
        title,
        asin: it.asin || null,
        image: sellerSkuImage(it.productImageLink),
        size,
        color,
        quantity: it.returnQuantity || 1,
        reason: valueOf(it.returnReason),
        resolution: valueOf(it.resolution),
        replacementOrderId: valueOf(it.replacementOrderId),
      };
    }),
  };
}

async function lookupAmazonReturn(mode, rawValue, headers) {
  let searchBy;
  let term;
  if (mode === 'order') {
    term = normalizeOrderId(rawValue);
    if (!term) return { error: 'That doesn\'t look like an Amazon order ID (###-#######-#######).', status: 400 };
    searchBy = 'OrderId';
  } else {
    term = normalizeTracking(rawValue);
    if (!term) return { error: 'Scan or type a return tracking number.', status: 400 };
    searchBy = 'CarrierTrackingId';
  }
  const data = await amazonGet(returnsUrl(searchBy, term), headers);
  const returns = (data.returnRequests || []).map(shapeReturn);
  if (!returns.length) {
    return { error: `No Amazon return found for ${mode === 'order' ? 'order' : 'tracking'} ${term} (last 365 days).`, status: 404 };
  }
  return { searched: term, returns };
}

module.exports = { lookupAmazonPacked, lookupAmazonReturn, normalizeOrderId, normalizeTracking };
