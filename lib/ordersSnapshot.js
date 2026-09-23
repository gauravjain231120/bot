const { getDb } = require('./db');
const { fetchOrderItems, pickImageUrl } = require('./myntra');

// The dashboard's "Open orders" grid used to call Myntra + Amazon LIVE every
// 60s per open tab — 1 + one-per-open-order Myntra calls fired at once, plus
// Amazon's, ~11,500 calls/day for one tab left open — far more than the actual
// alert checks, all from Vercel's servers. That's the kind of pattern
// marketplace bot protection flags. Now the 5-minute checks (which call the
// marketplaces anyway) save what they fetched here, and /api/orders only
// reads it: the dashboard makes zero marketplace calls, and the grid is at
// most one check old.
//
// Myntra's order list has no item detail, so each order's items are fetched
// ONCE (when the new-order alert runs, or by the small backfill below for
// orders that were already open) and cached by order id.

const MYNTRA_SNAPSHOT_ID = 'snapshot_myntra_open';
const AMAZON_SNAPSHOT_ID = 'snapshot_amazon_unshipped';
const ITEMS = 'myntraOrderItems';
const BACKFILL_PER_RUN = 3; // gentle: at most this many extra Myntra calls per 5-min check
const ITEM_CACHE_TTL_MS = 45 * 24 * 60 * 60 * 1000;

async function saveMyntraOpenOrders(orders) {
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: MYNTRA_SNAPSHOT_ID },
    {
      $set: {
        fetchedAt: new Date().toISOString(),
        orders: orders.map((o) => ({ orderId: String(o.orderId), quantity: o.quantity ?? null, orderDate: o.orderDate ?? null })),
      },
    },
    { upsert: true },
  );
}

function trimItem(item) {
  return {
    sellerSkuCode: item.sellerSkuCode || null,
    skuCode: item.skuCode || null,
    productDisplayName: item.productDisplayName || null,
    size: item.size || null,
    color: item.color || null,
    qty: item.qty ?? 1,
    image: pickImageUrl(item),
  };
}

async function cacheMyntraOrderItems(orderId, items) {
  try {
    const db = await getDb();
    await db.collection(ITEMS).updateOne(
      { _id: String(orderId) },
      { $set: { items: items.map(trimItem), fetchedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    console.error('order-items cache write failed:', err.message);
  }
}

// A cancellation can remove lines from an order that's still open — drop its
// cached items so the backfill re-fetches the remaining (CREATED) lines.
async function forgetMyntraOrderItems(orderIds) {
  if (!orderIds.length) return;
  try {
    const db = await getDb();
    await db.collection(ITEMS).deleteMany({ _id: { $in: orderIds.map(String) } });
  } catch (err) {
    console.error('order-items cache invalidate failed:', err.message);
  }
}

// Called at the end of each Myntra order check: fetches items for a few open
// orders that aren't cached yet, and prunes very old cache entries. Never
// throws — a miss just shows the order without item detail until next time.
async function backfillMyntraOrderItems(orders, headers) {
  try {
    const db = await getDb();
    const col = db.collection(ITEMS);
    const ids = orders.map((o) => String(o.orderId));
    const cached = ids.length ? await col.find({ _id: { $in: ids } }).project({ _id: 1 }).toArray() : [];
    const have = new Set(cached.map((d) => d._id));
    for (const id of ids.filter((x) => !have.has(x)).slice(0, BACKFILL_PER_RUN)) {
      try {
        await cacheMyntraOrderItems(id, await fetchOrderItems(id, headers));
      } catch (err) {
        if (err.response && [401, 403].includes(err.response.status)) break; // session problem: stop, don't hammer
      }
    }
    await col.deleteMany({ fetchedAt: { $lt: new Date(Date.now() - ITEM_CACHE_TTL_MS) } });
  } catch (err) {
    console.error('order-items backfill failed:', err.message);
  }
}

// Only the fields /api/orders actually uses — not the whole Seller Central
// payload (which carries buyer/blob data we don't need to keep).
async function saveAmazonUnshippedOrders(orders) {
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: AMAZON_SNAPSHOT_ID },
    {
      $set: {
        fetchedAt: new Date().toISOString(),
        orders: orders.map((o) => ({
          amazonOrderId: o.amazonOrderId,
          orderDate: o.orderDate ?? null,
          latestShipDate: o.latestShipDate ?? null,
          orderItems: (o.orderItems || []).map((it) => ({
            sellerSku: it.sellerSku || null,
            productName: it.productName || null,
            extendedTitle: it.extendedTitle || null,
            imageUrl: it.imageUrl || null,
            quantityOrdered: it.quantityOrdered ?? null,
            quantityShipped: it.quantityShipped ?? null,
            quantityUnShipped: it.quantityUnShipped ?? null,
            quantityCanceled: it.quantityCanceled ?? null,
          })),
        })),
      },
    },
    { upsert: true },
  );
}

async function loadSnapshots() {
  const db = await getDb();
  const [myntra, amazon] = await Promise.all([
    db.collection('settings').findOne({ _id: MYNTRA_SNAPSHOT_ID }),
    db.collection('settings').findOne({ _id: AMAZON_SNAPSHOT_ID }),
  ]);
  const ids = ((myntra && myntra.orders) || []).map((o) => o.orderId);
  const itemDocs = ids.length ? await db.collection(ITEMS).find({ _id: { $in: ids } }).toArray() : [];
  return { myntra, amazon, myntraItems: new Map(itemDocs.map((d) => [d._id, d.items || []])) };
}

module.exports = {
  saveMyntraOpenOrders,
  cacheMyntraOrderItems,
  forgetMyntraOrderItems,
  backfillMyntraOrderItems,
  saveAmazonUnshippedOrders,
  loadSnapshots,
};
