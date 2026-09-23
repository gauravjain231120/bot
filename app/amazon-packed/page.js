'use client';

import { useState } from 'react';
import { AmazonScanInput, DateRow, ItemCard, StatusBadge } from '../../components/AmazonScanShared';

const RECENT_LIMIT = 10;

function OrderResult({ order }) {
  const firstPkg = order.packages[0];
  const pickupText = firstPkg && firstPkg.pickupStart
    ? `${firstPkg.pickupStart.text}${firstPkg.pickupEnd ? ` – ${firstPkg.pickupEnd.text.split(', ').pop()}` : ''}`
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{order.orderId}</span>
        <StatusBadge status={order.status} />
        {order.cod && <span className="muted" style={{ fontSize: '0.8rem', fontWeight: 600 }}>COD</span>}
        {order.packages.length > 1 && <span className="muted" style={{ fontSize: '0.8rem' }}>{order.packages.length} packages</span>}
      </div>

      {order.packages.map((pkg, pi) => (
        <div key={pkg.trackingId || pi} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(order.packages.length > 1 || pkg.trackingId) && (
            <div className="muted" style={{ fontSize: '0.8rem' }}>
              Package {order.packages.length > 1 ? `${pi + 1} · ` : ''}
              <span style={{ fontFamily: 'monospace' }}>{pkg.trackingId || 'no tracking yet'}</span>
              {pkg.carrier ? ` · ${pkg.carrier}` : ''}
              {pkg.scanned && order.packages.length > 1 ? ' · ← scanned' : ''}
            </div>
          )}
          {pkg.items.map((item, i) => <ItemCard key={`${item.sku}-${i}`} item={item} />)}
        </div>
      ))}
      {order.items.map((item, i) => <ItemCard key={`${item.sku}-${i}`} item={item} />)}

      <div style={{ fontSize: '0.88rem' }}>
        <DateRow label="Order received" value={order.orderDate} />
        <DateRow label="Ship by" value={order.shipBy} />
        {pickupText && <DateRow label="Pickup slot">{pickupText}</DateRow>}
        <DateRow label="Deliver by" value={order.deliverBy} />
        {order.labelStatus && <DateRow label="Label">{order.labelStatus}</DateRow>}
      </div>
    </div>
  );
}

export default function AmazonPackedPage() {
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [repeatScan, setRepeatScan] = useState(false);
  const [recent, setRecent] = useState([]);

  async function lookup(mode, value) {
    setLooking(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch(`/api/dashboard/amazon-packed-lookup?mode=${mode}&id=${encodeURIComponent(value)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return false;
      }
      const orderIds = data.orders.map((o) => o.orderId);
      setRepeatScan(recent.some((r) => orderIds.includes(r.orderId)));
      setResult(data);
      setRecent((list) => [
        ...data.orders.map((o) => ({
          orderId: o.orderId,
          status: o.status,
          tracking: (o.packages[0] && o.packages[0].trackingId) || null,
          items: [...o.packages.flatMap((p) => p.items), ...o.items].map((it) => `${it.sku || '?'} · ${it.size || '?'}`),
        })),
        ...list.filter((r) => !orderIds.includes(r.orderId)),
      ].slice(0, RECENT_LIMIT));
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setLooking(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Amazon Pack</h1>
        <p className="muted">
          Scan the shipping label&apos;s tracking barcode, or switch to Order ID and read the printed order number
          with the camera — shows the product, SKU, size and the order&apos;s dates.
        </p>
      </div>

      <div className="card">
        <AmazonScanInput pageKey="packed" busy={looking} onLookup={lookup} trackingPlaceholder="Tracking number, e.g. 370407917226" />

        {error && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}

        {result && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {repeatScan && <div className="muted" style={{ fontSize: '0.8rem' }}>You already scanned this one earlier in this session.</div>}
            {result.orders.length > 1 && (
              <div className="muted" style={{ fontSize: '0.8rem' }}>{result.orders.length} orders match {result.searched}</div>
            )}
            {result.orders.map((o) => <OrderResult key={o.orderId} order={o} />)}
          </div>
        )}
      </div>

      {recent.length > 1 && (
        <div className="card">
          <h2>Scanned this session</h2>
          {recent.map((r) => (
            <div key={r.orderId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.orderId}</div>
                <div className="muted" style={{ fontSize: '0.8rem' }}>
                  {r.tracking ? `${r.tracking} · ` : ''}{r.items.join(', ')}
                </div>
              </div>
              <StatusBadge status={r.status} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
