const axios = require('axios');
const { formatIST } = require('./dates');
const { pickAmazonImage, extractVariant } = require('./amazon');
const { persistAmazonCookies } = require('./myntraCookies');

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
    let res;
    try {
      res = await axios.get(url, { headers, validateStatus: () => true, timeout: 20000 });
    } catch (err) {
      // No answer at all (timeout / connection reset): one retry, then give up.
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
    if (res.status === 200 && res.data && typeof res.data === 'object') {
      await persistAmazonCookies(headers, res); // Amazon re-issues session-token on each call
      return res.data;
    }
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
      // What shipped, else what's ordered less anything cancelled (a fully
      // cancelled line is 0 pieces, not 1).
      quantity: it.QuantityShipped || Math.max(0, (it.QuantityOrdered || full.QuantityOrdered || 1) - (Number(full.QuantityCanceled) || 0)),
      price: full.ItemCost && full.ItemCost.UnitPrice ? full.ItemCost.UnitPrice.Amount : null,
    };
  };

  const packages = (order.packages || []).map((p) => ({
    packageId: p.PackageId || null,
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
  const found = [];
  for (const id of orderIds.slice(0, 5)) {
    const order = await fetchOrderDetail(id, headers);
    if (order) found.push(order);
  }
  if (!found.length) return { error: `Found order ${orderIds[0]} but couldn't load its details.`, status: 502 };
  const orders = carryingTracking(found, tracking).map((order) => shapeOrder(order, tracking));
  return { searched: tracking, orders };
}

// The search matched these orders by tracking number; keep only the ones whose
// own package really carries it (a loose search match must never put another
// order's product on screen — or into a return). If none lists package
// tracking at all, there's nothing to check against: keep them.
function carryingTracking(orders, tracking) {
  const matching = orders.filter((o) => (o.packages || []).some((p) => normalizeTracking(p.TrackingId) === tracking));
  return matching.length ? matching : orders;
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
    returnType: 'CUSTOMER', // found in Manage Returns = the customer sent it back
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

// ---- RTO (returned to seller) ----
//
// An RTO — the parcel never reached the customer (COD refused, cancelled in
// transit, undeliverable) and came back — never creates a return REQUEST, so
// Manage Returns (the search above) has nothing for it. It only shows on the
// order itself: status ReturningToSeller (on its way back) or
// ReturnedToSeller (back with you). Verified live on 404-0757348-7486720.
// The RTO parcel's own return-label number (e.g. 515230465036) isn't linked
// to the order anywhere Amazon lets us search — only the original outbound
// tracking is — so an RTO is found by order id, or by the ORIGINAL tracking.
const RTO_STATUSES = ['ReturnedToSeller', 'ReturningToSeller'];

// Latest "Returned to seller" / "Returning to seller" event from the Easy Ship
// tracking history (the same request the order page's "Track package" makes).
// Best-effort — a failure just means no date is shown.
async function rtoEventDates(orderId, pkg, headers) {
  if (!pkg || !pkg.packageId || !pkg.trackingId) return {};
  try {
    const data = await amazonGet(
      `https://sellercentral.amazon.in/easyship-api/v1/track?orderId=${encodeURIComponent(orderId)}` +
        `&packageId=${encodeURIComponent(pkg.packageId)}&trackingId=${encodeURIComponent(pkg.trackingId)}`,
      headers,
    );
    const events = ((data.TrackingInformationList || [])[0] || {}).TrackingEventList || [];
    const latest = (re) => {
      const hits = events.filter((e) => re.test(e.EventDescription || '')).map((e) => e.EventEpoch);
      return hits.length ? at(Math.max(...hits), 'ms') : null;
    };
    return { returnedDate: latest(/^returned to seller/i), returningDate: latest(/^returning to seller/i) };
  } catch (err) {
    if (err.sessionExpired) throw err;
    return {};
  }
}

// Shapes an RTO order like a return request so the page can treat both the
// same way (items, condition picker, Add to Return).
async function shapeRto(order, headers) {
  const shaped = shapeOrder(order, null);
  const pkg = shaped.packages[0] || null;
  const dates = await rtoEventDates(shaped.orderId, pkg, headers);
  const items = shaped.packages.length ? shaped.packages.flatMap((p) => p.items) : shaped.items;
  return {
    returnRequestId: `rto:${shaped.orderId}`,
    rto: true,
    returnType: 'RTO',
    orderId: shaped.orderId,
    status: shaped.status,
    // Logged under the original outbound tracking (the only one Amazon
    // links to this order) unless the page has the scanned label number.
    trackingId: pkg ? pkg.trackingId : null,
    carrier: pkg ? pkg.carrier : null,
    exchange: false,
    cod: shaped.cod,
    requestDate: null,
    orderDate: shaped.orderDate,
    shipDate: pkg ? pkg.shipDate : null,
    returningDate: dates.returningDate || null,
    returnedDate: dates.returnedDate || null,
    closeDate: null,
    items: items.map((it) => ({ ...it, reason: 'RTO — not delivered, came back to you', resolution: null, replacementOrderId: null })),
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
  if (returns.length) return { searched: term, returns };

  // No customer return request — check whether it's an RTO instead.
  if (mode === 'order') {
    const order = await fetchOrderDetail(term, headers);
    if (!order) return { error: `No Amazon order found for ${term}.`, status: 404 };
    const status = order.orderStatus && order.orderStatus.OrderStatus;
    if (RTO_STATUSES.includes(status)) return { searched: term, returns: [await shapeRto(order, headers)] };
    return {
      error: `Order ${term} has no customer return and isn't an RTO (its status is "${status || 'unknown'}").`,
      status: 404,
    };
  }

  // Tracking mode: the scanned number may be the ORIGINAL outbound tracking
  // of an RTO parcel.
  const orderIds = await findOrderIdByTracking(term, headers);
  const found = [];
  for (const id of orderIds.slice(0, 5)) {
    const order = await fetchOrderDetail(id, headers);
    if (order) found.push(order);
  }
  const rtos = [];
  for (const order of carryingTracking(found, normalizeTracking(term))) {
    const status = order.orderStatus && order.orderStatus.OrderStatus;
    if (RTO_STATUSES.includes(status)) rtos.push(await shapeRto(order, headers));
  }
  if (rtos.length) return { searched: term, returns: rtos };
  if (orderIds.length) {
    return { error: `Tracking ${term} belongs to order ${orderIds[0]}, which has no customer return and isn't an RTO.`, status: 404 };
  }
  return {
    error: `No Amazon return found for tracking ${term}. If this is an RTO parcel (it never reached the customer), ` +
      'its return-label number isn\'t searchable on Amazon — switch to Order ID and scan the order number instead.',
    status: 404,
  };
}

module.exports = { lookupAmazonPacked, lookupAmazonReturn, normalizeOrderId, normalizeTracking };
