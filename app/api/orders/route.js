import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { isAuthed } from '../../../lib/adminAuth';
import {
  pickAmazonImage,
  amazonOrderDateMs,
  amazonShipByDateMs,
  extractVariant,
  groupAmazonItemsBySku,
} from '../../../lib/amazon';
import { lookupStockMany } from '../../../lib/stock';
import { myntraShipByDateMs } from '../../../lib/dates';
import { loadSnapshots } from '../../../lib/ordersSnapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Reads ONLY what the 5-minute checks already saved (lib/ordersSnapshot.js) —
// this route makes no Myntra/Amazon calls at all. It used to fetch both live
// on every 60s dashboard poll, per open tab (1 + one-per-order Myntra calls
// fired at once, plus Amazon), which dwarfed the alert checks themselves and
// looked nothing like a person using Seller Central / M-Direct.
const STALE_MS = 15 * 60 * 1000; // 3 missed 5-min checks

function staleNote(label, snapshot) {
  if (!snapshot || !snapshot.fetchedAt) return `${label}: no orders saved yet — they appear after the next check runs`;
  const age = Date.now() - new Date(snapshot.fetchedAt).getTime();
  if (age <= STALE_MS) return null;
  const mins = Math.round(age / 60000);
  return `${label}: showing orders from ${mins} min ago (checks are paused or failing)`;
}

function myntraOrders(snapshot, itemsById, stockBySku) {
  const orders = (snapshot && snapshot.orders) || [];
  return orders.map((order) => ({
    source: 'myntra',
    orderId: order.orderId,
    quantity: order.quantity,
    orderDateMs: order.orderDate,
    shipByMs: myntraShipByDateMs(order.orderDate),
    items: (itemsById.get(String(order.orderId)) || []).map((item) => {
      const sku = item.sellerSkuCode || item.skuCode;
      return {
        sku,
        name: item.productDisplayName,
        size: item.size,
        color: item.color,
        qty: item.qty,
        image: item.image,
        stock: stockBySku.get(sku) ?? null,
      };
    }),
  }));
}

function amazonOrders(snapshot, stockBySku) {
  const orders = (snapshot && snapshot.orders) || [];
  return orders.map((order) => {
    const items = groupAmazonItemsBySku(order.orderItems);
    return {
      source: 'amazon',
      orderId: order.amazonOrderId,
      quantity: items.reduce((sum, item) => sum + (item.qty || 1), 0),
      orderDateMs: amazonOrderDateMs(order),
      shipByMs: amazonShipByDateMs(order),
      items: items.map((item) => {
        const { size, color } = extractVariant(item);
        return {
          sku: item.sellerSku,
          name: item.productName || item.extendedTitle,
          size,
          color,
          qty: item.qty,
          image: pickAmazonImage(item),
          stock: stockBySku.get(item.sellerSku) ?? null,
        };
      }),
    };
  });
}

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  const [{ myntra, amazon, myntraItems }, sessions] = await Promise.all([
    loadSnapshots(),
    Promise.all([
      db.collection('settings').findOne({ _id: 'session' }, { projection: { _id: 1 } }),
      db.collection('settings').findOne({ _id: 'session_amazon' }, { projection: { _id: 1 } }),
    ]),
  ]);
  // Every SKU on the grid's stock in ONE read (was one full-collection scan
  // per item, every refresh).
  const skus = [
    ...((myntra && myntra.orders) || []).flatMap((o) => (myntraItems.get(String(o.orderId)) || []).map((i) => i.sellerSkuCode || i.skuCode)),
    ...((amazon && amazon.orders) || []).flatMap((o) => (o.orderItems || []).map((i) => i.sellerSku)),
  ];
  const stockBySku = await lookupStockMany(skus);
  const myntraList = myntraOrders(myntra, myntraItems, stockBySku);
  const amazonList = amazonOrders(amazon, stockBySku);

  const orders = [...myntraList, ...amazonList].sort((a, b) => (b.orderDateMs || 0) - (a.orderDateMs || 0));
  // A marketplace with no session at all isn't set up — say nothing about it.
  const errors = [sessions[0] && staleNote('Myntra', myntra), sessions[1] && staleNote('Amazon', amazon)].filter(Boolean);

  return NextResponse.json({ orders, error: errors.length ? errors.join(' · ') : null });
}
