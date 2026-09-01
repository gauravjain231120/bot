import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { isAuthed } from '../../../lib/adminAuth';
import { fetchOpenOrders, fetchOrderItems, pickImageUrl } from '../../../lib/myntra';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No session saved yet.' }, { status: 400 });
  }
  const headers = sessionDoc.headers;

  let orders;
  try {
    orders = await fetchOpenOrders(headers);
  } catch (err) {
    const status = err.response && err.response.status;
    return NextResponse.json(
      { error: `Failed to load orders${status ? ` (HTTP ${status})` : ''}` },
      { status: 502 }
    );
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
        orderId: order.orderId,
        quantity: order.quantity,
        orderDate: order.orderDate,
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

  enriched.sort((a, b) => (b.orderDate || 0) - (a.orderDate || 0));

  return NextResponse.json({ orders: enriched });
}
