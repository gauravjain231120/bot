'use client';

import { useState } from 'react';
import { MyntraScanInput } from '../../components/MyntraScanInput';
import { playScanError, playScanSuccess, unlockScanSound } from '../../components/scanSound';
import { ItemCountBanner, NumberedImage, numberPieces } from '../../components/ItemCount';

// Myntra's packetStatus values seen on real packets, most to least advanced.
// Anything else still shows, just as its raw value.
const STATUS_STYLES = {
  SHIPPED: { label: 'Shipped', color: 'var(--good)', background: 'var(--good-soft)' },
  PICKED: { label: 'Picked', color: 'var(--accent)', background: 'var(--accent-soft)' },
  PACKED: { label: 'Packed', color: 'var(--text)', background: 'var(--surface-2)' },
};
// Any status saying CANCEL (Myntra's exact word for it isn't pinned down).
const CANCELLED_STYLE = { label: 'Cancelled', color: 'var(--bad)', background: 'var(--bad-soft)' };

const RECENT_LIMIT = 10;

function StatusBadge({ status }) {
  const style =
    STATUS_STYLES[status] || (/CANCEL/i.test(String(status || '')) ? CANCELLED_STYLE : { label: status || 'Unknown', color: 'var(--text)', background: 'var(--surface-2)' });
  return (
    <span style={{ display: 'inline-block', fontWeight: 700, fontSize: '0.8rem', borderRadius: 6, padding: '2px 8px', color: style.color, background: style.background }}>
      {style.label}
    </span>
  );
}

// Hidden when Myntra hasn't set that time (e.g. Picked/Shipped on a packet
// still waiting for pickup).
function DateRow({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
      <span className="muted">{label}</span>
      <span>{value.text}</span>
    </div>
  );
}

export default function PackedScanPage() {
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');
  const [packet, setPacket] = useState(null);
  const [repeatScan, setRepeatScan] = useState(false);
  const [recent, setRecent] = useState([]);

  // `idOverride` lets the camera scanner look up the just-decoded text
  // immediately instead of waiting a render for state to update.
  async function lookup(idOverride) {
    const id = (idOverride ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!id || looking) return;
    unlockScanSound();
    setLooking(true);
    setError('');
    setPacket(null);
    setRepeatScan(recent.some((r) => r.searchedId === id || r.trackingNumber === id));
    try {
      const res = await fetch(`/api/dashboard/packed-lookup?id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        playScanError();
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      // A cancelled packet sounds like a wrong scan — "don't pack" without looking.
      const p = data.packet;
      if (p.cancelled || p.manualCancel || (p.items.length && p.items.every((it) => it.cancelled))) playScanError();
      else playScanSuccess();
      setPacket(data.packet);
      setRecent((list) => [
        data.packet,
        ...list.filter((r) => r.trackingNumber !== data.packet.trackingNumber),
      ].slice(0, RECENT_LIMIT));
    } catch (err) {
      playScanError();
      setError(err.message);
    } finally {
      setLooking(false);
    }
  }

  // Pieces to pack: none of a cancelled line (it gets the red ✕ instead) — nor
  // of a parcel marked cancelled on the Myntra Cancel page.
  const isOff = (it) => it.cancelled || !!(packet && packet.manualCancel);
  const pieces = packet ? numberPieces(packet.items.map((it) => (isOff(it) ? 0 : it.quantity))) : null;
  const cancelledUnits = packet ? packet.items.reduce((a, it) => a + (isOff(it) ? it.quantity || 1 : 0), 0) : 0;

  return (
    <>
      <div className="page-header">
        <h1>Myntra Pack</h1>
      </div>

      <div className="card">
        <MyntraScanInput
          pageKey="packed"
          busy={looking}
          onLookup={lookup}
          placeholder="MYSP… / MYSC… / packet ID"
        />

        {error && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}

        {packet && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <ItemCountBanner count={pieces.total} cancelled={cancelledUnits} noun="packet" verb="Pack" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{packet.trackingNumber}</span>
              <StatusBadge status={packet.status} />
            </div>
            {packet.manualCancel && (
              <div className="banner bad" style={{ marginBottom: 0, fontWeight: 700 }}>
                ✕ Marked cancelled on the Myntra Cancel page
                {packet.manualCancel.markedBy ? ` by ${packet.manualCancel.markedBy}` : ''} — don&apos;t hand this one to the courier.
              </div>
            )}
            {repeatScan && (
              <div className="muted" style={{ fontSize: '0.8rem' }}>You already scanned this one earlier in this session.</div>
            )}

            {packet.items.map((item, i) => (
              <div key={`${item.skuId}-${i}`} style={{ display: 'flex', gap: 12, padding: 10, border: isOff(item) ? '2px solid var(--bad)' : '1px solid var(--border)', borderRadius: 10 }}>
                <NumberedImage src={item.image} label={pieces.labels[i]} cancelled={isOff(item)} />
                <div style={{ flex: 1, minWidth: 0, fontSize: '0.9rem' }}>
                  <div style={{ fontWeight: 600 }}>{item.productName || 'Unknown product'}</div>
                  <div className="muted" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{item.sellerSkuCode || item.myntraSku || `skuId ${item.skuId}`}</div>
                  <div style={{ marginTop: 4 }}>
                    <span style={{ display: 'inline-block', fontWeight: 700, fontSize: '1.05rem', color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 6, padding: '2px 8px' }}>
                      Size: {item.size || '?'}
                    </span>
                    {item.color ? <span className="muted"> · {item.color}</span> : ''}
                  </div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    Qty: {item.quantity}
                    {item.finalAmount != null ? ` · ₹${item.finalAmount}` : ''}
                    {item.mrp != null && item.mrp !== item.finalAmount ? ` (MRP ₹${item.mrp})` : ''}
                  </div>
                  {isOff(item) && (
                    <div style={{ marginTop: 6, fontWeight: 800, color: 'var(--bad)' }}>✕ Cancelled — don&apos;t pack this</div>
                  )}
                </div>
              </div>
            ))}

            <div style={{ fontSize: '0.88rem' }}>
              <DateRow label="Packed" value={packet.packedOn} />
              <DateRow label="Pack by" value={packet.packBy} />
              <DateRow label="Picked" value={packet.pickedOn} />
              <DateRow label="Pick by" value={packet.pickBy} />
              <DateRow label="Shipped" value={packet.shippedOn} />
              {packet.storePacketId && (
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}>
                  <span className="muted">Packet ID</span>
                  <span style={{ fontFamily: 'monospace' }}>{packet.storePacketId}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {recent.length > 1 && (
        <div className="card">
          <h2>Scanned this session</h2>
          {recent.map((r) => (
            <div key={r.trackingNumber} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.trackingNumber}</div>
                <div className="muted" style={{ fontSize: '0.8rem' }}>
                  {r.items.map((it) => `${it.sellerSkuCode || it.skuId} · ${it.size || '?'}`).join(', ')}
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
