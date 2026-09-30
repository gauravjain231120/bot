'use client';

import { useCallback, useEffect, useState } from 'react';
import { MyntraScanInput } from '../../components/MyntraScanInput';
import { playScanError, playScanSuccess, unlockScanSound } from '../../components/scanSound';
import { formatDateTime } from '../../lib/format';

// A packed parcel that won't go out (the courier refused it, or the order was
// cancelled after packing): scanned here it's left out of the packed counts,
// and stock-manager marks its Shipped entry Cancelled and puts the stock back
// (or takes it out of Ready to Ship). lib/manualCancels.js does the work.

const TONE = { good: 'var(--good)', bad: 'var(--bad)', warn: 'var(--accent)' };
const TAKEN = ['PICKED', 'SHIPPED', 'DELIVERED'];

async function call(method, body, query = '') {
  const res = await fetch(`/api/dashboard/myntra-cancel${query}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function Thumb({ src }) {
  if (!src) return <div style={{ width: 44, height: 58, borderRadius: 6, background: 'var(--surface-2)', flexShrink: 0 }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" style={{ width: 44, height: 58, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />;
}

function Items({ items }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((it, i) => (
        <div key={`${it.sellerSkuCode}-${i}`} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Thumb src={it.image} />
          <div style={{ minWidth: 0, fontSize: '0.88rem' }}>
            <div style={{ fontWeight: 600 }}>{it.productName || 'Unknown product'}</div>
            <div className="muted" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{it.sellerSkuCode || '—'}</div>
            <div className="muted">
              Size {it.size || '?'}
              {it.color ? ` · ${it.color}` : ''} · Qty {it.quantity || 1}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Summary({ lines }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.85rem' }}>
      {lines.map((l, i) => (
        <div key={i} style={{ color: TONE[l.tone] || 'var(--text)', fontWeight: 600 }}>{l.text}</div>
      ))}
    </div>
  );
}

// The order the parcel belongs to, as the scan found it — and, when it isn't
// sure, the orders to pick from.
// Orders packed within 30 min of the parcel (lib/manualCancels.js PICK_WINDOW_SEC).
const PICK_WINDOW_SEC = 30 * 60;

function OrderChoice({ match, value, onChange }) {
  const pickable = (match.candidates || []).filter((c) => c.deltaSec != null && c.deltaSec <= PICK_WINDOW_SEC);
  if (match.orderId && match.sure) {
    return (
      <div style={{ fontSize: '0.9rem' }}>
        Order <b style={{ fontFamily: 'monospace' }}>{match.orderId}</b> <span className="muted">— matched by packing time</span>
      </div>
    );
  }
  if (!pickable.length) {
    return (
      <div className="banner" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', marginBottom: 0 }}>
        {match.reason || "Couldn't tell which order this is."} It will still be left out of the packed count, but stock won&apos;t be changed —
        fix it by hand in stock-manager if needed.
      </div>
    );
  }
  return (
    <div style={{ fontSize: '0.88rem' }}>
      <div style={{ marginBottom: 6 }}>
        {match.orderId ? 'Two orders of this product were packed at almost the same time — check which one:' : 'Which order is it?'}
      </div>
      {pickable.map((c) => (
        <label key={c.orderId} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
          <input type="radio" name="order" checked={value === c.orderId} onChange={() => onChange(c.orderId)} />
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{c.orderId}</span>
          <span className="muted">packed {c.deltaSec < 90 ? `${c.deltaSec}s` : `${Math.round(c.deltaSec / 60)} min`} from this parcel</span>
        </label>
      ))}
    </div>
  );
}

function Entry({ entry, onChanged }) {
  const [busy, setBusy] = useState('');
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [error, setError] = useState(entry.undoError || '');

  async function run(kind) {
    setBusy(kind);
    setError('');
    try {
      if (kind === 'retry') await call('POST', { action: 'retry', trackingNumber: entry.trackingNumber });
      if (kind === 'undo') await call('POST', { action: 'undo', trackingNumber: entry.trackingNumber });
      if (kind === 'delete') await call('DELETE', null, `?id=${encodeURIComponent(entry.trackingNumber)}`);
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
      setConfirmUndo(false);
    }
  }

  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{entry.trackingNumber}</span>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          {formatDateTime(entry.markedAt)}
          {entry.markedBy ? ` · ${entry.markedBy}` : ''}
        </span>
      </div>
      <Items items={entry.items} />
      <div style={{ fontSize: '0.85rem' }}>
        {entry.orderId ? (
          <>
            Order <b style={{ fontFamily: 'monospace' }}>{entry.orderId}</b>
            {entry.matchedBy ? <span className="muted"> ({entry.matchedBy})</span> : null}
          </>
        ) : (
          <span className="muted">No order found</span>
        )}
      </div>
      <Summary lines={entry.summary} />
      {error && <div className="banner bad" style={{ marginBottom: 0 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {entry.stockState === 'FAILED' || entry.stockState === 'PENDING' ? (
          <button type="button" disabled={!!busy} onClick={() => run('retry')}>
            {busy === 'retry' ? 'Retrying…' : 'Retry stock'}
          </button>
        ) : null}
        {confirmUndo ? (
          <>
            <span style={{ fontSize: '0.85rem' }}>Scanned by mistake? Stock goes back to how it was and the parcel counts again.</span>
            <button type="button" className="danger" disabled={!!busy} onClick={() => run('undo')}>
              {busy === 'undo' ? 'Undoing…' : 'Yes, undo'}
            </button>
            <button type="button" className="secondary" disabled={!!busy} onClick={() => setConfirmUndo(false)}>
              No
            </button>
          </>
        ) : (
          <button type="button" className="secondary" disabled={!!busy} onClick={() => setConfirmUndo(true)}>
            Undo
          </button>
        )}
        <button
          type="button"
          className="secondary"
          disabled={!!busy || !entry.canDelete}
          onClick={() => run('delete')}
          title={entry.canDelete ? 'Remove from this list — stock is not changed' : undefined}
        >
          {busy === 'delete' ? 'Removing…' : 'Delete'}
        </button>
        {!entry.canDelete ? (
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            can be deleted from {formatDateTime(entry.deletableAt)} (after 4 days it&apos;s out of the packed count anyway)
          </span>
        ) : (
          <span className="muted" style={{ fontSize: '0.78rem' }}>Delete only removes it from this list — stock stays as it is.</span>
        )}
      </div>
    </div>
  );
}

export default function MyntraCancelPage() {
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState(null); // { trackingNumber, packet, match } | { already }
  const [orderPick, setOrderPick] = useState(null);
  const [marking, setMarking] = useState(false);
  const [result, setResult] = useState(null);
  const [entries, setEntries] = useState(null);
  const [listError, setListError] = useState('');

  const loadList = useCallback(async () => {
    try {
      const data = await call('GET');
      setEntries(data.entries || []);
      setListError('');
    } catch (err) {
      setListError(err.message);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  async function lookup(raw) {
    const id = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!id || looking) return false;
    unlockScanSound();
    setLooking(true);
    setError('');
    setFound(null);
    setResult(null);
    try {
      const data = await call('POST', { action: 'lookup', id });
      setFound(data);
      setOrderPick(data.match ? data.match.orderId : null);
      if (data.already) playScanError();
      else playScanSuccess();
      return true;
    } catch (err) {
      playScanError();
      setError(err.message);
      return false;
    } finally {
      setLooking(false);
    }
  }

  async function mark() {
    if (!found || !found.packet) return;
    setMarking(true);
    setError('');
    try {
      const data = await call('POST', { action: 'mark', trackingNumber: found.trackingNumber, orderId: orderPick });
      setResult(data.entry);
      setFound(null);
      await loadList();
    } catch (err) {
      setError(err.message);
    } finally {
      setMarking(false);
    }
  }

  const packet = found && found.packet;
  const match = found && found.match;
  const taken = packet && TAKEN.includes(packet.status);

  return (
    <>
      <div className="page-header">
        <h1>Myntra Cancel</h1>
      </div>

      <div className="card">
        <MyntraScanInput pageKey="myntraCancel" busy={looking || marking} onLookup={lookup} placeholder="MYSP… / MYSC… / MYEC… / SF…" />
        {looking && <p className="muted" style={{ marginTop: 10 }}>Looking it up on Myntra and finding its order…</p>}
        {error && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}

        {found && found.already && (
          <div style={{ marginTop: 14 }}>
            <div className="banner bad" style={{ marginBottom: 10 }}>
              Already marked cancelled on {formatDateTime(found.already.markedAt)}
              {found.already.markedBy ? ` by ${found.already.markedBy}` : ''}.
            </div>
            <Summary lines={found.already.summary} />
          </div>
        )}

        {packet && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '1.05rem' }}>{found.trackingNumber}</span>
              <span className="muted" style={{ fontSize: '0.85rem' }}>
                Myntra: {packet.status || 'unknown'}
                {packet.packedOn ? ` · packed ${packet.packedOn.text}` : ''}
              </span>
            </div>
            <Items items={packet.items} />
            <OrderChoice match={match} value={orderPick} onChange={setOrderPick} />
            {taken && (
              <div className="banner bad" style={{ marginBottom: 0 }}>
                Myntra shows the courier already took this parcel ({packet.status}). Only mark it if it&apos;s back with you — a parcel
                coming back later is logged on Myntra Return instead.
              </div>
            )}
            {match && match.myntraCancelled && (
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                Myntra already lists this order as cancelled — the bot&apos;s own cancel check handles it too. Marking it here is still
                fine: nothing is counted twice.
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="danger" disabled={marking} onClick={mark}>
                {marking ? 'Saving…' : 'Mark cancelled'}
              </button>
              <button type="button" className="secondary" disabled={marking} onClick={() => setFound(null)}>
                Not this one
              </button>
            </div>
          </div>
        )}

        {result && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>✓ {result.trackingNumber} marked cancelled — left out of the packed count.</div>
            <Summary lines={result.summary} />
          </div>
        )}
      </div>

      <div className="card">
        <h2>Cancelled parcels{entries ? ` (${entries.length})` : ''}</h2>
        {listError && <div className="banner bad">{listError}</div>}
        {entries === null && !listError && <p className="muted">Loading…</p>}
        {entries && entries.length === 0 && <p className="muted">Nothing marked cancelled yet.</p>}
        {entries && entries.map((e) => <Entry key={e.trackingNumber} entry={e} onChanged={loadList} />)}
      </div>
    </>
  );
}
