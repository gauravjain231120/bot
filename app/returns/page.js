'use client';

import { useState } from 'react';
import { MyntraScanInput } from '../../components/MyntraScanInput';
import { playScanError, playScanSuccess, unlockScanSound } from '../../components/scanSound';
import { RETURN_CONDITIONS, RETURN_CONDITION_LABELS } from '../../lib/format';
import { ReturnTypeTag } from '../../components/ReturnTypeTag';
import { useDashboard } from '../../lib/DashboardContext';
import { myntraUnits } from '../../lib/returnUnits';
import { ItemCountBanner, NumberedImage } from '../../components/ItemCount';

const RECENT_LIMIT = 10;

export default function ReturnsPage() {
  // Customer return vs RTO is Owner-only (the API also leaves it out for others).
  const { isOwner } = useDashboard();
  const [myntraResolving, setMyntraResolving] = useState(false);
  const [myntraResolveError, setMyntraResolveError] = useState('');
  const [myntraCandidates, setMyntraCandidates] = useState([]);
  // The tracking id the candidates below were resolved from — kept apart from
  // the input so the input can be cleared for the next scan while "Add to
  // Return" still logs against the id that was actually looked up.
  const [resolvedId, setResolvedId] = useState('');
  const [repeatScan, setRepeatScan] = useState(false);
  // This tab's scans only, in memory — same as Scan Packed's list, gone on
  // refresh. Each entry tracks its items' added/condition state too.
  const [recent, setRecent] = useState([]);

  /**
   * Scan a Myntra return tracking id and resolve it — same underlying
   * resolver as stock-manager's own Returns page, just reachable straight
   * from this dashboard so a return can be logged without opening
   * stock-manager at all. A shipment carrying more than one product resolves
   * to more than one candidate (confirmed real case) — always rendered as a
   * list, never assumes exactly one result. `idOverride` lets the camera
   * scanner resolve immediately with the just-decoded text instead of
   * waiting a render cycle for state to update.
   */
  async function resolveMyntraReturn(idOverride) {
    const id = (idOverride ?? '').trim().toUpperCase();
    if (!id || myntraResolving) return;
    unlockScanSound();
    setMyntraResolving(true);
    setMyntraResolveError('');
    setMyntraCandidates([]);
    setResolvedId('');
    setRepeatScan(recent.some((r) => r.trackingId === id));
    try {
      const res = await fetch(`/api/dashboard/resolve-return?trackingId=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        playScanError();
        setMyntraResolveError(data.error || `HTTP ${res.status}`);
        return;
      }
      // A rescan of a parcel already added this session shows it as added
      // (same as Amazon Return) instead of offering "Add" again — a second
      // tap used to log the same return twice.
      const earlier = recent.find((r) => r.trackingId === id);
      const addedBefore = (key) => (earlier && (earlier.items.find((it) => it.unitKey === key) || {}).addedCondition) || null;
      const candidates = myntraUnits(data.candidates || []).map((c) => {
        const addedCondition = addedBefore(c.unitKey);
        return { ...c, condition: addedCondition || 'GOOD', adding: false, added: !!addedCondition, addedCondition, addError: '' };
      });
      setMyntraCandidates(candidates);
      setResolvedId(id);
      playScanSuccess();
      setRecent((list) => {
        const previous = list.find((r) => r.trackingId === id);
        const items = candidates.map((c) => ({
          unitKey: c.unitKey,
          returnType: c.returnType,
          sku: c.matchedSku ?? c.resolvedSku,
          size: c.size,
          // A rescan keeps what was already added from this tracking id.
          addedCondition: (previous && (previous.items.find((it) => it.unitKey === c.unitKey) || {}).addedCondition) || null,
        }));
        return [{ trackingId: id, items }, ...list.filter((r) => r.trackingId !== id)].slice(0, RECENT_LIMIT);
      });
    } catch (err) {
      playScanError();
      setMyntraResolveError(err.message);
    } finally {
      setMyntraResolving(false);
    }
  }

  function setCandidateCondition(index, condition) {
    setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, condition } : c)));
  }

  // allowDuplicate: stock-manager refuses a second return with the same
  // tracking id + SKU; "Log it again anyway" (a genuine second unit) resends
  // with this set.
  async function addReturnCandidate(index, allowDuplicate = false) {
    const candidate = myntraCandidates[index];
    if (!candidate || !candidate.matchedSku || candidate.adding || candidate.added) return;
    setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: true, addError: '', duplicate: false } : c)));
    try {
      const res = await fetch('/api/dashboard/add-return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // One claim = one unit (qty 1). expectedUnits = how many units of this
        // product the parcel holds, so a genuine 2nd unit logs normally.
        body: JSON.stringify({
          sku: candidate.matchedSku,
          qty: 1,
          trackingId: resolvedId,
          condition: candidate.condition,
          returnType: candidate.returnType,
          orderId: candidate.orderId,
          expectedUnits: candidate.unitsOfSku || 1,
          allowDuplicate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: false, addError: data.error || `HTTP ${res.status}`, duplicate: !!data.duplicate } : c)));
        return;
      }
      setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: false, added: true, addedCondition: candidate.condition } : c)));
      setRecent((list) => list.map((r) => (r.trackingId === resolvedId
        ? { ...r, items: r.items.map((it) => (it.unitKey === candidate.unitKey ? { ...it, addedCondition: candidate.condition } : it)) }
        : r)));
    } catch (err) {
      setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: false, addError: err.message } : c)));
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Myntra Return</h1>
      </div>

      <div className="card">
        <MyntraScanInput
          pageKey="returns"
          busy={myntraResolving}
          onLookup={resolveMyntraReturn}
        />

        {myntraResolveError && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{myntraResolveError}</div>}

        {myntraCandidates.length > 0 && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* One candidate = one physical piece (lib/returnUnits.js). */}
            <ItemCountBanner count={myntraCandidates.length} noun="return" verb="Check" />
            <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{resolvedId}</div>
            {repeatScan && (
              <div className="muted" style={{ fontSize: '0.8rem' }}>You already scanned this one earlier in this session.</div>
            )}
            {myntraCandidates.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
                <NumberedImage src={c.image} label={String(i + 1)} />
                <div style={{ flex: 1, minWidth: 0, fontSize: '0.9rem' }}>
                  {isOwner && <div style={{ marginBottom: 4 }}><ReturnTypeTag type={c.returnType} /></div>}
                  <div style={{ fontWeight: 600 }}>{c.productName ?? c.resolvedSku}</div>
                  <div className="muted" style={{ fontFamily: 'monospace' }}>{c.matchedSku ?? c.resolvedSku}</div>
                  {c.size && (
                    <div style={{ marginTop: 4 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          fontWeight: 700,
                          fontSize: '1.05rem',
                          color: 'var(--accent)',
                          background: 'var(--accent-soft)',
                          borderRadius: 6,
                          padding: '2px 8px',
                        }}
                      >
                        Size: {c.size}
                      </span>
                      {c.color ? <span className="muted"> · {c.color}</span> : ''}
                    </div>
                  )}
                  {c.unitsOfSku > 1 && (
                    <div style={{ marginTop: 4, fontWeight: 600 }}>
                      Unit {c.unitN} of {c.unitsOfSku} of this product in the parcel — grade and add each one
                    </div>
                  )}
                  {c.orderId && <div className="muted">Order: <span style={{ fontFamily: 'monospace' }}>{c.orderId}</span></div>}
                  {c.returnReason && <div className="muted">Reason: {c.returnReason}</div>}
                  {c.returnCreatedDate && <div className="muted">Return created: {c.returnCreatedDate}</div>}
                  {c.matchError && <div style={{ color: 'var(--bad)' }}>{c.matchError}</div>}

                  {c.matchedSku && !c.added && (
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      <select value={c.condition} onChange={(e) => setCandidateCondition(i, e.target.value)} disabled={c.adding}>
                        {RETURN_CONDITIONS.map((k) => (
                          <option key={k} value={k}>{RETURN_CONDITION_LABELS[k]}</option>
                        ))}
                      </select>
                      <button type="button" onClick={() => addReturnCandidate(i)} disabled={c.adding}>
                        {c.adding ? 'Adding…' : 'Add to Return'}
                      </button>
                    </div>
                  )}
                  {c.added && (
                    <div style={{ marginTop: 8, color: 'var(--good)', fontWeight: 600 }}>
                      ✓ Added{c.addedCondition ? ` (${RETURN_CONDITION_LABELS[c.addedCondition] || c.addedCondition})` : ''}
                    </div>
                  )}
                  {c.addError && <div style={{ marginTop: 6, color: 'var(--bad)' }}>{c.addError}</div>}
                  {c.duplicate && !c.added && (
                    <button type="button" className="secondary" style={{ marginTop: 6 }} onClick={() => addReturnCandidate(i, true)} disabled={c.adding}>
                      Log it again anyway
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {recent.length > 1 && (
        <div className="card">
          <h2>Scanned this session</h2>
          {recent.map((r) => (
            <div key={r.trackingId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.trackingId}</div>
                <div className="muted" style={{ fontSize: '0.8rem' }}>
                  {r.items.length
                    ? (isOwner ? `${r.items[0].returnType === 'RTO' ? 'RTO' : r.items[0].returnType === 'CUSTOMER' ? 'Customer return' : 'Unknown'} · ` : '') +
                      r.items.map((it) => `${it.sku || '?'} · ${it.size || '?'}`).join(', ')
                    : 'No item found'}
                </div>
              </div>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', color: r.items.some((it) => it.addedCondition) ? 'var(--good)' : 'var(--text-dim)' }}>
                {r.items.some((it) => it.addedCondition)
                  ? `✓ Added (${r.items.filter((it) => it.addedCondition).map((it) => RETURN_CONDITION_LABELS[it.addedCondition]).join(', ')})`
                  : 'Not added'}
              </span>
            </div>
          ))}
        </div>
      )}

    </>
  );
}
