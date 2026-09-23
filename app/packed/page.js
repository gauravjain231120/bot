'use client';

import { useEffect, useRef, useState } from 'react';
import { BarcodeScanner } from '../../components/BarcodeScanner';

// Myntra's packetStatus values seen on real packets, most to least advanced.
// Anything else still shows, just as its raw value.
const STATUS_STYLES = {
  SHIPPED: { label: 'Shipped', color: 'var(--good)', background: 'var(--good-soft)' },
  PICKED: { label: 'Picked', color: 'var(--accent)', background: 'var(--accent-soft)' },
  PACKED: { label: 'Packed', color: 'var(--text)', background: 'var(--surface-2)' },
};

const RECENT_LIMIT = 10;

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || { label: status || 'Unknown', color: 'var(--text)', background: 'var(--surface-2)' };
  return (
    <span style={{ display: 'inline-block', fontWeight: 700, fontSize: '0.8rem', borderRadius: 6, padding: '2px 8px', color: style.color, background: style.background }}>
      {style.label}
    </span>
  );
}

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
  const [scanId, setScanId] = useState('');
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');
  const [packet, setPacket] = useState(null);
  const [repeatScan, setRepeatScan] = useState(false);
  const [recent, setRecent] = useState([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const inputRef = useRef(null);

  // A USB/Bluetooth barcode scanner "types" the code and presses Enter into
  // whatever has focus — keeping the input focused means scan after scan
  // works without touching the screen. Only on mouse/keyboard devices: on a
  // phone it would pop the on-screen keyboard up after every camera scan.
  useEffect(() => {
    const finePointer = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (finePointer && !looking && !cameraOpen && inputRef.current) inputRef.current.focus();
  }, [looking, cameraOpen]);

  // `idOverride` lets the camera scanner look up the just-decoded text
  // immediately instead of waiting a render for state to update.
  async function lookup(idOverride) {
    const id = (idOverride ?? scanId).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!id || looking) return;
    setScanId(id);
    setLooking(true);
    setError('');
    setPacket(null);
    setRepeatScan(recent.some((r) => r.searchedId === id || r.trackingNumber === id));
    try {
      const res = await fetch(`/api/dashboard/packed-lookup?id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setPacket(data.packet);
      setRecent((list) => [
        data.packet,
        ...list.filter((r) => r.trackingNumber !== data.packet.trackingNumber),
      ].slice(0, RECENT_LIMIT));
      // Ready for the next scan straight away.
      setScanId('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLooking(false);
    }
  }

  function handleBarcodeDetected(text) {
    setCameraOpen(false);
    lookup(text);
  }

  return (
    <>
      <div className="page-header">
        <h1>Scan packed / picked</h1>
        <p className="muted">
          Scan or type a shipping label&apos;s tracking number (MYSP… / MYSC… / MYEC… / MYEP…) or packet ID —
          shows the product, SKU, size, color and when it was packed, picked and shipped.
        </p>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            ref={inputRef}
            value={scanId}
            onChange={(e) => setScanId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } }}
            placeholder="MYSP… / MYSC… / packet ID"
            style={{ flex: 1, fontFamily: 'monospace' }}
            autoComplete="off"
          />
          <button type="button" onClick={() => lookup()} disabled={looking || !scanId.trim()}>
            {looking ? 'Looking up…' : 'Look up'}
          </button>
        </div>

        <button
          type="button"
          className="secondary"
          onClick={() => setCameraOpen(true)}
          disabled={looking}
          style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
        >
          📷 Scan with camera
        </button>

        {error && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}

        {packet && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{packet.trackingNumber}</span>
              <StatusBadge status={packet.status} />
              {packet.items.length > 1 && (
                <span className="muted" style={{ fontSize: '0.8rem' }}>{packet.items.length} items in this packet</span>
              )}
            </div>
            {repeatScan && (
              <div className="muted" style={{ fontSize: '0.8rem' }}>You already scanned this one earlier in this session.</div>
            )}

            {packet.items.map((item, i) => (
              <div key={`${item.skuId}-${i}`} style={{ display: 'flex', gap: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.image}
                    alt=""
                    style={{ width: 170, maxWidth: '38vw', height: 'auto', maxHeight: 250, borderRadius: 10, objectFit: 'contain', flexShrink: 0 }}
                  />
                ) : null}
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
                </div>
              </div>
            ))}

            <div style={{ fontSize: '0.88rem' }}>
              <DateRow label="Packed" value={packet.packedOn} />
              <DateRow label="Picked" value={packet.pickedOn} />
              <DateRow label="Shipped" value={packet.shippedOn} />
              {!packet.pickedOn && <DateRow label="Pick by" value={packet.pickBy} />}
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

      {cameraOpen && <BarcodeScanner onDetected={handleBarcodeDetected} onClose={() => setCameraOpen(false)} />}
    </>
  );
}
