import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { isAuthed } from '../../../lib/adminAuth';
import { fetchOpenOrders, fetchOrderItems, pickImageUrl } from '../../../lib/myntra';
import { fetchUnshippedOrders, pickAmazonImage, amazonOrderDateMs, amazonShipByDateMs } from '../../../lib/amazon';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loadMyntraOrders(db) {
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) return { orders: [], error: null };
  const headers = sessionDoc.headers;

  let orders;
  try {
    orders = await fetchOpenOrders(headers);
  } catch (err) {
    const status = err.response && err.response.status;
    return { orders: [], error: `Myntra: failed to load orders${status ? ` (HTTP ${status})` : ''}` };
  }

  const enriched = await Promise.all(
    orders.map(async (order) => {
      let items = [];
      try {
        items = await fetchOrderItems(order.orderId, headers);
      } catch {
        // leave items empty — the card just shows the bare order without product detail
      }
      return {
        source: 'myntra',
        orderId: order.orderId,
        quantity: order.quantity,
        orderDateMs: order.orderDate,
        shipByMs: order.packByTime || null,
        items: items.map((item) => ({
          sku: item.sellerSkuCode || item.skuCode,
          name: item.productDisplayName,
          size: item.size,
          color: item.color,
          image: pickImageUrl(item),
        })),
      };
    })
  );

  return { orders: enriched, error: null };
}

async function loadAmazonOrders(db) {
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session_amazon' });
  if (!sessionDoc || !sessionDoc.headers) return { orders: [], error: null };
  const headers = sessionDoc.headers;

  let orders;
  try {
    orders = await fetchUnshippedOrders(headers);
  } catch (err) {
    const status = err.response && err.response.status;
    return { orders: [], error: `Amazon: failed to load orders${status ? ` (HTTP ${status})` : ''}` };
  }

  const mapped = orders.map((order) => ({
    source: 'amazon',
    orderId: order.amazonOrderId,
    quantity: (order.orderItems || []).reduce((sum, item) => sum + (item.quantityOrdered || 1), 0),
    orderDateMs: amazonOrderDateMs(order),
    shipByMs: amazonShipByDateMs(order),
    items: (order.orderItems || []).map((item) => ({
      sku: item.sellerSku,
      name: item.productName || item.extendedTitle,
      size: null,
      color: null,
      image: pickAmazonImage(item),
    })),
  }));

  return { orders: mapped, error: null };
}

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  const [myntra, amazon] = await Promise.all([loadMyntraOrders(db), loadAmazonOrders(db)]);

  const orders = [...myntra.orders, ...amazon.orders].sort((a, b) => (b.orderDateMs || 0) - (a.orderDateMs || 0));
  const errors = [myntra.error, amazon.error].filter(Boolean);

  return NextResponse.json({ orders, error: errors.length ? errors.join(' · ') : null });
}
