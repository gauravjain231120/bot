'use client';

import { useState } from 'react';
import { AmazonScanInput, DateRow, ItemCard, StatusBadge } from '../../components/AmazonScanShared';
import { playScanError, playScanSuccess } from '../../components/scanSound';
import { ItemCountBanner, numberPieces } from '../../components/ItemCount';

const RECENT_LIMIT = 10;

// Every item of an order, in the order they're shown: packed ones by package, then the rest.
const orderItems = (o) => [...o.packages.flatMap((p) => p.items), ...o.items];
// Pieces to pack on a line: none of a cancelled one.
const toPack = (it) => (it.cancelled ? 0 : it.quantity);
// Nothing on it left to pack (cancelled order, or every line cancelled).
const allCancelled = (o) => o.cancelled || orderItems(o).every((it) => it.cancelled);

// `labels`: the piece number of each item, in orderItems order.
function OrderResult({ order, labels }) {
  let k = 0;
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
          {pkg.items.map((item, i) => <ItemCard key={`${item.sku}-${i}`} item={item} number={labels[k++]} showCancelled />)}
        </div>
      ))}
      {order.items.map((item, i) => <ItemCard key={`${item.sku}-${i}`} item={item} number={labels[k++]} showCancelled />)}

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
        playScanError();
        setError(data.error || `HTTP ${res.status}`);
        return false;
      }
      // A cancelled order sounds like a wrong scan — "don't pack" without looking.
      if (data.orders.length && data.orders.every(allCancelled)) playScanError();
      else playScanSuccess();
      const orderIds = data.orders.map((o) => o.orderId);
      setRepeatScan(recent.some((r) => orderIds.includes(r.orderId)));
      setResult(data);
      setRecent((list) => [
        ...data.orders.map((o) => ({
          orderId: o.orderId,
          status: o.status,
          tracking: (o.packages[0] && o.packages[0].trackingId) || null,
          items: orderItems(o).map((it) => `${it.title || it.catalogName ? (it.title || it.catalogName) + ' · ' : ''}${it.sku || '?'} · ${it.size || '?'}`),
        })),
        ...list.filter((r) => !orderIds.includes(r.orderId)),
      ].slice(0, RECENT_LIMIT));
      return true;
    } catch (err) {
      playScanError();
      setError(err.message);
      return false;
    } finally {
      setLooking(false);
    }
  }

  // Pieces numbered across the whole result (normally one order).
  const pieces = result ? numberPieces(result.orders.flatMap(orderItems).map(toPack)) : null;
  const cancelledUnits = result
    ? result.orders.flatMap(orderItems).reduce((a, it) => a + (it.cancelled ? it.cancelledQty || it.quantity || 1 : it.cancelledQty || 0), 0)
    : 0;
  let offset = 0;
  const labelsFor = (o) => {
    const n = orderItems(o).length;
    offset += n;
    return pieces.labels.slice(offset - n, offset);
  };

  return (
    <>
      <div className="page-header">
        <h1>Amazon Pack</h1>
      </div>

      <div className="card">
        <AmazonScanInput pageKey="packed" busy={looking} onLookup={lookup} trackingPlaceholder="Tracking number, e.g. 370407917226" />

        {error && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}

        {result && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Split into 2+ packages, one label doesn't hold everything — no "pack all". */}
            <ItemCountBanner
              count={pieces.total}
              cancelled={cancelledUnits}
              noun={result.orders.length > 1 ? 'scan' : 'order'}
              verb={result.orders.some((o) => o.packages.length > 1) ? undefined : 'Pack'}
            />
            {repeatScan && <div className="muted" style={{ fontSize: '0.8rem' }}>You already scanned this one earlier in this session.</div>}
            {result.orders.length > 1 && (
              <div className="muted" style={{ fontSize: '0.8rem' }}>{result.orders.length} orders match {result.searched}</div>
            )}
            {result.orders.map((o) => <OrderResult key={o.orderId} order={o} labels={labelsFor(o)} />)}
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
