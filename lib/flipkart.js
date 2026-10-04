const axios = require('axios');

const FLIPKART_GRAPHQL_URL = 'https://seller.flipkart.com/orchestrator/graphql?';

// The GraphQL query to fetch pending (not yet accepted) shipments
const GET_SHIPMENT_GROUPS_QUERY = `query GetShipmentGroups($input: ShipmentGroupFilterRequestInput!) {
  filteredShipmentGroups(input: $input) {
    shipmentGroups {
      groupId
      subGroupIndex
      logisticsPartnerCounts {
        partner
        count
      }
      groupDetails {
        shipmentGroupSpecs {
          listing {
            listingId
            status
            product {
              productId
              title
              fsn
              sku
              primaryImageUrl
              productUrl
            }
          }
          quantity
        }
        packages {
          packageId
          dimensions {
            length
            breadth
            height
            weight
          }
        }
      }
      sellerInputAttributes {
        shippingId
        orderId
      }
      shipmentCount
      subShipmentCount
      priceRange {
        minPrice
        maxPrice
      }
      missingDimensions
      isMps
      packagingPolicy
      channelOfSale
    }
    pageInfo {
      hasMore
      total
    }
    timestamp
  }
}`;

// Fetch pending orders from Flipkart Seller Hub
async function fetchFlipkartOrders(headers) {
  const cookieHeader = headers.cookie;
  const csrfToken = extractCsrfToken(cookieHeader);
  const sellerId = extractSellerId(cookieHeader);
  const locationId = headers['x-location-id'] || extractLocationId(cookieHeader);

  const requestHeaders = {
    'accept': '*/*',
    'content-type': 'application/json',
    'cookie': cookieHeader,
    'fk-csrf-token': csrfToken,
    'operation': 'query',
    'operation-name': 'GetShipmentGroups',
    'origin': 'https://seller.flipkart.com',
    'referer': 'https://seller.flipkart.com/index.html',
    'x-client-id': 'SD',
    'x-internal-env-type': 'WEB',
    'x-requested-with': 'XMLHttpRequest',
    'user-agent': headers['user-agent'] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  };
  if (sellerId) requestHeaders['x-user-id'] = sellerId;
  if (locationId) requestHeaders['x-location-id'] = locationId;

  // Add browser-like headers if available
  if (headers['sec-ch-ua']) requestHeaders['sec-ch-ua'] = headers['sec-ch-ua'];
  if (headers['sec-ch-ua-mobile']) requestHeaders['sec-ch-ua-mobile'] = headers['sec-ch-ua-mobile'];
  if (headers['sec-ch-ua-platform']) requestHeaders['sec-ch-ua-platform'] = headers['sec-ch-ua-platform'];
  if (headers['accept-language']) requestHeaders['accept-language'] = headers['accept-language'];

  // First call: get shipment groups (summary)
  const groupsRes = await axios.post(FLIPKART_GRAPHQL_URL, {
    query: GET_SHIPMENT_GROUPS_QUERY,
    variables: {
      input: {
        status: 'pendingToAccept',
        viewType: { groupedByFsn: true },
        paginationInput: { pageNum: 1, pageSize: 50 },
        shipmentParams: {
          seller_id: sellerId,
          location_id: locationId || ''
        }
      }
    },
    },
  }, { headers: requestHeaders, timeout: 30000 });

  const groupsData = groupsRes.data;
  if (!groupsData || !groupsData.data || !groupsData.data.filteredShipmentGroups) {
    if (groupsData && groupsData.graphErrors && groupsData.graphErrors.length) {
      const errMsg = groupsData.graphErrors[0].message || JSON.stringify(groupsData.graphErrors[0]);
      if (errMsg.toLowerCase().includes('auth') || errMsg.toLowerCase().includes('login') || errMsg.toLowerCase().includes('unauthorized')) {
        const err = new Error('Flipkart session expired: ' + errMsg);
        err.sessionExpired = true;
        throw err;
      }
      throw new Error('Flipkart GraphQL error: ' + errMsg);
    }
    throw new Error('Unexpected Flipkart response shape');
  }

  const groups = groupsData.data.filteredShipmentGroups.shipmentGroups || [];
  const total = groupsData.data.filteredShipmentGroups.pageInfo?.total || groups.length;
  
  // Flatten groups into individual order items
  const orders = [];
  for (const group of groups) {
    // Each group may have shipments array (detail) or groupDetails (summary)
    if (group.shipments && group.shipments.length) {
      for (const shipment of group.shipments) {
        const specs = (group.groupDetails && group.groupDetails.shipmentGroupSpecs) || [];
        orders.push({
          groupId: group.groupId,
          orderId: shipment.orderId,
          shippingId: shipment.shippingId,
          internalId: shipment.internalId,
          channelOfSale: shipment.channelOfSale || group.channelOfSale || 'FLIPKART',
          sellerPrice: shipment.sellerPrice,
          paymentMode: shipment.paymentMode,
          creationTime: shipment.creationTime,
          dispatchByDate: shipment.dispatchByDate,
          dispatchAfterDate: shipment.dispatchAfterDate,
          tracking: shipment.tracking || {},
          statusHistory: shipment.statusHistory || {},
          items: specs.map(s => ({
            title: s.listing?.product?.displayTitle || s.listing?.product?.title || 'Unknown',
            brand: s.listing?.product?.brand || '',
            sku: s.listing?.product?.sku || '',
            size: s.listing?.product?.size || '',
            image: s.listing?.product?.primaryImageUrl || null,
            productId: s.listing?.product?.productId || '',
            quantity: s.quantity || 1,
          })),
        });
      }
    } else {
      // Summary-only group (no shipments detail yet)
      const specs = (group.groupDetails && group.groupDetails.shipmentGroupSpecs) || [];
      orders.push({
        groupId: group.groupId,
        orderId: null,
        channelOfSale: group.channelOfSale || 'FLIPKART',
        sellerPrice: group.priceRange ? group.priceRange.maxPrice : null,
        items: specs.map(s => ({
          title: s.listing?.product?.displayTitle || s.listing?.product?.title || 'Unknown',
          brand: s.listing?.product?.brand || '',
          sku: s.listing?.product?.sku || '',
          size: s.listing?.product?.size || '',
          image: s.listing?.product?.primaryImageUrl || null,
          productId: s.listing?.product?.productId || '',
          quantity: s.quantity || 1,
        })),
      });
    }
  }

  return { orders, total };
}

// Probe the Flipkart session to see if it works
async function probeFlipkartSession(headers) {
  // A minimal GraphQL call — just check if we get data back without auth errors
  const result = await fetchFlipkartOrders(headers);
  return result;
}

function isFlipkartSessionExpired(err) {
  return !!(err && (err.sessionExpired || (err.response && (err.response.status === 401 || err.response.status === 403))));
}

// Extract CSRF token from cookie string
function extractCsrfToken(cookieStr) {
  if (!cookieStr) return '';
  // The CSRF token cookie name based on user's data
  const match = cookieStr.match(/XyZ7pQ9rS2T1uV8wA3bC6dE4fG0h=([^;]+)/);
  if (match) return match[1];
  // Fallback: look for fk-csrf-token pattern
  const m2 = cookieStr.match(/fk-csrf-token=([^;]+)/);
  return m2 ? m2[1] : '';
}

// Extract seller ID from cookie string
function extractSellerId(cookieStr) {
  if (!cookieStr) return '';
  const match = cookieStr.match(/sellerId=([^;]+)/);
  return match ? match[1] : '';
}

// Extract location ID from cookie string
function extractLocationId(cookieStr) {
  if (!cookieStr) return '';
  // Try x-location-id pattern in cookies if stored
  return '';
}

const { escapeHtml } = require('./html');

function formatFlipkartAlert(order, openCount = null) {
  const item = (order.items && order.items[0]) || {};
  const itemCount = (order.items || []).reduce((s, i) => s + (i.quantity || 1), 0);
  const price = order.sellerPrice ? '₹' + Number(order.sellerPrice).toLocaleString('en-IN') : '';
  const payment = order.paymentMode ? ' (' + order.paymentMode.charAt(0).toUpperCase() + order.paymentMode.slice(1) + ')' : '';
  const dispatchBy = order.dispatchByDate ? formatFlipkartDate(order.dispatchByDate) : '';
  const multiLine = itemCount > 1 ? '🔀 <b>MULTI ORDER</b> (' + itemCount + ' items)\n' : '';
  const openLine = openCount != null ? '\n\n📊 Open: ' + openCount : '';

  return (
    '🛒 <b>New Flipkart order</b>\n' +
    multiLine +
    (order.orderId ? 'Order: <code>' + escapeHtml(order.orderId) + '</code>\n' : '') +
    '<b>' + escapeHtml(item.title || 'Unknown product') + '</b>\n' +
    'SKU: <code>' + escapeHtml(item.sku || '?') + '</code>\n' +
    (item.size ? 'Size: ' + escapeHtml(item.size) + '\n' : '') +
    (price ? '💰 ' + price + payment + '\n' : '') +
    (dispatchBy ? '📦 Dispatch by: ' + dispatchBy : '') +
    openLine
  );
}

function formatFlipkartDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return dateStr;
  }
}

module.exports = {
  fetchFlipkartOrders,
  probeFlipkartSession,
  isFlipkartSessionExpired,
  formatFlipkartAlert,
  extractCsrfToken,
  extractSellerId,
};
