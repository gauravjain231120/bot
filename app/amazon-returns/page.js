'use client';

import { useState } from 'react';
import { AmazonScanInput, DateRow, ItemCard, StatusBadge, humanize, humanizeReason } from '../../components/AmazonScanShared';
import { RETURN_CONDITIONS, RETURN_CONDITION_LABELS } from '../../lib/format';
import { ReturnTypeTag, RETURN_TYPE_HINTS } from '../../components/ReturnTypeTag';
import { useDashboard } from '../../lib/DashboardContext';

const RECENT_LIMIT = 10;
const itemKey = (rr, i) => `${rr.returnRequestId}:${i}`;

export default function AmazonReturnsPage() {
  // Customer return vs RTO is Owner-only (the API also leaves it out for others).
  const { isOwner } = useDashboard();
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [repeatScan, setRepeatScan] = useState(false);
  // Per-item UI state, keyed by returnRequestId + item index, so a
  // multi-item return can be added one item at a time.
  const [itemState, setItemState] = useState({});
  const [recent, setRecent] = useState([]);

  const patchItem = (key, patch) => setItemState((s) => ({ ...s, [key]: { ...s[key], ...patch } }));

  async function lookup(mode, value) {
    setLooking(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch(`/api/dashboard/amazon-return-lookup?mode=${mode}&id=${encodeURIComponent(value)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return false;
      }
      const ids = data.returns.map((r) => r.returnRequestId);
      setRepeatScan(recent.some((r) => ids.includes(r.returnRequestId)));
      // A rescan keeps what was already added from it this session.
      setItemState((prev) => {
        const next = {};
        for (const rr of data.returns) {
          rr.items.forEach((_, i) => {
            const k = itemKey(rr, i);
            next[k] = prev[k] && prev[k].added ? prev[k] : { condition: 'GOOD' };
          });
        }
        return { ...prev, ...next };
      });
      setResult({ ...data, mode });
      setRecent((list) => [
        ...data.returns.map((rr) => ({
          returnRequestId: rr.returnRequestId,
          orderId: rr.orderId,
          trackingId: rr.trackingId,
          returnType: rr.returnType,
          items: rr.items.map((it) => `${it.sku || '?'} · ${it.size || '?'}`),
        })),
        ...list.filter((r) => !ids.includes(r.returnRequestId)),
      ].slice(0, RECENT_LIMIT));
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setLooking(false);
    }
  }

  // allowDuplicate: see the Myntra Return page — "Log it again anyway".
  async function addItem(rr, i, allowDuplicate = false) {
    const key = itemKey(rr, i);
    const item = rr.items[i];
    const st = itemState[key] || {};
    if (!item.matchedSku || st.adding || st.added) return;
    patchItem(key, { adding: true, addError: '', duplicate: false });
    try {
      const res = await fetch('/api/dashboard/amazon-add-return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: item.matchedSku,
          qty: item.quantity || 1,
          // The return label's own tracking id — what's physically on the
          // parcel and what stock-manager's other Amazon returns are logged by.
          trackingId: rr.trackingId || (result.mode === 'tracking' ? result.searched : undefined),
          condition: st.condition || 'GOOD',
          returnType: rr.returnType || 'UNKNOWN',
          orderId: rr.orderId || undefined,
          allowDuplicate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        patchItem(key, { adding: false, addError: data.error || `HTTP ${res.status}`, duplicate: !!data.duplicate });
        return;
      }
      patchItem(key, { adding: false, added: true, addedCondition: st.condition || 'GOOD' });
    } catch (err) {
      patchItem(key, { adding: false, addError: err.message });
    }
  }

  function addedSummary(r) {
    const conds = [];
    for (let i = 0; i < r.items.length; i++) {
      const st = itemState[`${r.returnRequestId}:${i}`];
      if (st && st.added) conds.push(RETURN_CONDITION_LABELS[st.addedCondition] || st.addedCondition);
    }
    return conds;
  }

  return (
    <>
      <div className="page-header">
        <h1>Amazon Return</h1>
        <p className="muted">
          Scan the return parcel&apos;s tracking barcode, or switch to Order ID and read the printed order number with the
          camera — shows what&apos;s coming back and logs it into stock-manager as an Amazon return. Works for customer
          returns and RTOs (parcels that never reached the customer); for an RTO, use Order ID.
        </p>
      </div>

      <div className="card">
        <AmazonScanInput pageKey="returns" busy={looking} onLookup={lookup} trackingPlaceholder="Return tracking, e.g. 515235085376" />

        {error && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{error}</div>}

        {result && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {repeatScan && <div className="muted" style={{ fontSize: '0.8rem' }}>You already scanned this one earlier in this session.</div>}
            {result.returns.length > 1 && (
              <div className="muted" style={{ fontSize: '0.8rem' }}>{result.returns.length} returns found for {result.searched}</div>
            )}
            {result.returns.map((rr) => (
              <div key={rr.returnRequestId} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{rr.orderId}</span>
                  {isOwner && <ReturnTypeTag type={rr.returnType} />}
                  <StatusBadge status={rr.status} />
                  {rr.exchange && <span className="muted" style={{ fontSize: '0.8rem', fontWeight: 600 }}>Exchange</span>}
                  {rr.cod && <span className="muted" style={{ fontSize: '0.8rem', fontWeight: 600 }}>COD</span>}
                </div>
                {isOwner && <div className="muted" style={{ fontSize: '0.8rem' }}>{RETURN_TYPE_HINTS[rr.returnType] || RETURN_TYPE_HINTS.UNKNOWN}</div>}

                {rr.items.map((item, i) => {
                  const key = itemKey(rr, i);
                  const st = itemState[key] || {};
                  return (
                    <ItemCard key={key} item={item}>
                      {item.reason && <div className="muted">Reason: {rr.rto ? item.reason : humanizeReason(item.reason)}</div>}
                      {item.resolution && <div className="muted">Customer wants: {humanize(item.resolution).replace(/^Variational /, '')}</div>}
                      {item.matchError && <div style={{ color: 'var(--bad)' }}>{item.matchError}</div>}
                      {item.matchedSku && !st.added && (
                        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                          <select value={st.condition || 'GOOD'} onChange={(e) => patchItem(key, { condition: e.target.value })} disabled={st.adding}>
                            {RETURN_CONDITIONS.map((k) => <option key={k} value={k}>{RETURN_CONDITION_LABELS[k]}</option>)}
                          </select>
                          <button type="button" onClick={() => addItem(rr, i)} disabled={st.adding}>
                            {st.adding ? 'Adding…' : 'Add to Return'}
                          </button>
                        </div>
                      )}
                      {st.added && (
                        <div style={{ marginTop: 8, color: 'var(--good)', fontWeight: 600 }}>
                          ✓ Added ({RETURN_CONDITION_LABELS[st.addedCondition] || st.addedCondition})
                        </div>
                      )}
                      {st.addError && <div style={{ marginTop: 6, color: 'var(--bad)' }}>{st.addError}</div>}
                      {st.duplicate && !st.added && (
                        <button type="button" className="secondary" style={{ marginTop: 6 }} onClick={() => addItem(rr, i, true)} disabled={st.adding}>
                          Log it again anyway
                        </button>
                      )}
                    </ItemCard>
                  );
                })}

                <div style={{ fontSize: '0.88rem' }}>
                  {rr.trackingId && (
                    <DateRow label={rr.rto ? 'Original tracking' : 'Tracking'}>
                      <span style={{ fontFamily: 'monospace' }}>{rr.trackingId}</span>{rr.carrier ? ` · ${rr.carrier}` : ''}
                    </DateRow>
                  )}
                  <DateRow label="Order received" value={rr.orderDate} />
                  <DateRow label="Shipped" value={rr.shipDate} />
                  <DateRow label="Return requested" value={rr.requestDate} />
                  <DateRow label="Returning to you since" value={rr.returningDate} />
                  <DateRow label="Returned to you" value={rr.returnedDate} />
                  <DateRow label="Closed" value={rr.closeDate} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {recent.length > 1 && (
        <div className="card">
          <h2>Scanned this session</h2>
          {recent.map((r) => {
            const added = addedSummary(r);
            return (
              <div key={r.returnRequestId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.trackingId || r.orderId}</div>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>{isOwner ? `${r.returnType === 'RTO' ? 'RTO' : r.returnType === 'CUSTOMER' ? 'Customer return' : 'Unknown'} · ` : ''}{r.orderId} · {r.items.join(', ')}</div>
                </div>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', color: added.length ? 'var(--good)' : 'var(--text-dim)' }}>
                  {added.length ? `✓ Added (${added.join(', ')})` : 'Not added'}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
