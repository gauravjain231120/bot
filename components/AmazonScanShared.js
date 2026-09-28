'use client';

import { useEffect, useRef, useState } from 'react';
import { BarcodeScanner } from './BarcodeScanner';
import { OrderIdScanner } from './OrderIdScanner';
import { unlockScanSound } from './scanSound';
import { NumberedImage } from './ItemCount';

// Shared pieces of the Amazon Pack / Amazon Return scan pages. The Myntra
// scan pages don't use any of this — they're left exactly as they were.

const MODE_KEY_PREFIX = 'amazonScanMode:';

// "DeliveredToBuyer" -> "Delivered to buyer", "PendingRefund" -> "Pending refund".
export function humanize(value) {
  if (!value) return '';
  const spaced = String(value).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// Amazon return reason codes, e.g. "AMZ-PG-APP-TOO-LARGE" -> "Too large".
export function humanizeReason(code) {
  if (!code) return '';
  const text = String(code).replace(/^AMZ-/, '').replace(/^PG-/, '').replace(/^APP-/, '').replace(/-/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const GOOD = ['DeliveredToBuyer', 'Shipped', 'PickedUp', 'Completed', 'Closed'];
const BAD = ['Canceled', 'Cancelled', 'ReturnedToSeller'];

export function StatusBadge({ status }) {
  if (!status) return null;
  const tone = GOOD.includes(status)
    ? { color: 'var(--good)', background: 'var(--good-soft)' }
    : BAD.includes(status)
      ? { color: 'var(--bad)', background: 'var(--bad-soft)' }
      : { color: 'var(--accent)', background: 'var(--accent-soft)' };
  return (
    <span style={{ display: 'inline-block', fontWeight: 700, fontSize: '0.8rem', borderRadius: 6, padding: '2px 8px', ...tone }}>
      {humanize(status)}
    </span>
  );
}

export function DateRow({ label, value, children }) {
  if (!value && !children) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
      <span className="muted">{label}</span>
      <span style={{ textAlign: 'right' }}>{children ?? value.text}</span>
    </div>
  );
}

// Photo (with its piece number — see ItemCount), title, SKU, big size badge,
// color — same layout as the Myntra cards. `showCancelled` (the Pack page): a
// cancelled line gets the red ✕ and "don't pack"; a partly cancelled one says
// how many. The Return page leaves it off — a cancelled order coming back as
// an RTO is still a return to log.
export function ItemCard({ item, number, children, showCancelled = false }) {
  const cancelled = showCancelled && !!item.cancelled;
  const partly = showCancelled && !cancelled && item.cancelledQty > 0;
  return (
    <div style={{ display: 'flex', gap: 12, padding: 10, border: cancelled ? '2px solid var(--bad)' : '1px solid var(--border)', borderRadius: 10 }}>
      <NumberedImage src={item.image} label={number} cancelled={cancelled} />
      <div style={{ flex: 1, minWidth: 0, fontSize: '0.9rem' }}>
        <div style={{ fontWeight: 600 }}>{item.title || 'Unknown product'}</div>
        <div className="muted" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{item.sku || item.asin || '—'}</div>
        <div style={{ marginTop: 4 }}>
          <span style={{ display: 'inline-block', fontWeight: 700, fontSize: '1.05rem', color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 6, padding: '2px 8px' }}>
            Size: {item.size || '?'}
          </span>
          {item.color ? <span className="muted"> · {item.color}</span> : ''}
        </div>
        <div className="muted" style={{ marginTop: 4 }}>
          Qty: {item.quantity}
          {item.price != null ? ` · ₹${item.price}` : ''}
        </div>
        {cancelled && (
          <div style={{ marginTop: 6, fontWeight: 800, color: 'var(--bad)' }}>✕ Cancelled — don&apos;t pack this</div>
        )}
        {partly && (
          <div style={{ marginTop: 6, fontWeight: 700, color: 'var(--bad)' }}>
            {item.cancelledQty} of these cancelled — pack only {item.quantity}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * Tracking ID / Order ID toggle + input + camera + keyboard-scanner support.
 * Tracking mode opens the barcode scanner; Order ID mode opens the OCR reader
 * for the printed number. The chosen mode is remembered per page (this
 * browser only). Calls onLookup(mode, value).
 */
export function AmazonScanInput({ pageKey, busy, onLookup, trackingPlaceholder }) {
  const [mode, setMode] = useState('tracking');
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(null); // 'barcode' | 'ocr' | null
  const inputRef = useRef(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MODE_KEY_PREFIX + pageKey);
      if (saved === 'order' || saved === 'tracking') setMode(saved);
    } catch {
      // storage blocked — default mode is fine
    }
  }, [pageKey]);

  // Keep the box focused for USB/Bluetooth scanners — mouse/keyboard devices
  // only, so phones don't pop the keyboard after every camera scan.
  useEffect(() => {
    const finePointer = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (finePointer && !busy && !camera && inputRef.current) inputRef.current.focus();
  }, [busy, camera, mode]);

  function switchMode(next) {
    setMode(next);
    setValue('');
    try {
      window.localStorage.setItem(MODE_KEY_PREFIX + pageKey, next);
    } catch {
      // not remembered — fine
    }
  }

  async function submit(override) {
    const v = (override ?? value).trim();
    if (!v || busy) return;
    unlockScanSound();
    setValue(v);
    const ok = await onLookup(mode, v);
    if (ok) setValue('');
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }} role="tablist" aria-label="Search by">
        {[['tracking', 'Tracking ID'], ['order', 'Order ID']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            className={mode === key ? '' : 'secondary'}
            onClick={() => switchMode(key)}
            disabled={busy}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          placeholder={mode === 'order' ? '405-2404810-6349128' : trackingPlaceholder}
          inputMode={mode === 'order' ? 'numeric' : undefined}
          autoComplete="off"
          style={{ flex: 1, fontFamily: 'monospace' }}
        />
        <button type="button" onClick={() => submit()} disabled={busy || !value.trim()}>
          {busy ? 'Looking up…' : 'Look up'}
        </button>
      </div>
      <button
        type="button"
        className="secondary"
        onClick={() => { unlockScanSound(); setCamera(mode === 'order' ? 'ocr' : 'barcode'); }}
        disabled={busy}
        style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
      >
        {mode === 'order' ? '📷 Read order ID with camera' : '📷 Scan barcode with camera'}
      </button>

      {camera === 'barcode' && (
        <BarcodeScanner onDetected={(text) => { setCamera(null); submit(text); }} onClose={() => setCamera(null)} />
      )}
      {camera === 'ocr' && (
        <OrderIdScanner onDetected={(text) => { setCamera(null); submit(text); }} onClose={() => setCamera(null)} />
      )}
    </>
  );
}
