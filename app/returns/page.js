'use client';

import { useEffect, useRef, useState } from 'react';
import { BarcodeScanner } from '../../components/BarcodeScanner';
import { RETURN_CONDITIONS, RETURN_CONDITION_LABELS } from '../../lib/format';

const RECENT_LIMIT = 10;

export default function ReturnsPage() {
  const [myntraScanId, setMyntraScanId] = useState('');
  const [myntraResolving, setMyntraResolving] = useState(false);
  const [myntraResolveError, setMyntraResolveError] = useState('');
  const [myntraCandidates, setMyntraCandidates] = useState([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  // The tracking id the candidates below were resolved from — kept apart from
  // the input so the input can be cleared for the next scan while "Add to
  // Return" still logs against the id that was actually looked up.
  const [resolvedId, setResolvedId] = useState('');
  const [repeatScan, setRepeatScan] = useState(false);
  // This tab's scans only, in memory — same as Scan Packed's list, gone on
  // refresh. Each entry tracks its items' added/condition state too.
  const [recent, setRecent] = useState([]);
  const inputRef = useRef(null);

  // Keep the input focused for USB/Bluetooth scanners (they type the code +
  // Enter) — mouse/keyboard devices only, so phones don't pop the keyboard
  // up after every camera scan. Same as Scan Packed.
  useEffect(() => {
    const finePointer = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (finePointer && !myntraResolving && !cameraOpen && inputRef.current) inputRef.current.focus();
  }, [myntraResolving, cameraOpen]);

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
    const id = (idOverride ?? myntraScanId).trim().toUpperCase();
    if (!id || myntraResolving) return;
    setMyntraScanId(id);
    setMyntraResolving(true);
    setMyntraResolveError('');
    setMyntraCandidates([]);
    setResolvedId('');
    setRepeatScan(recent.some((r) => r.trackingId === id));
    try {
      const res = await fetch(`/api/dashboard/resolve-return?trackingId=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMyntraResolveError(data.error || `HTTP ${res.status}`);
        return;
      }
      const candidates = (data.candidates || []).map((c) => ({ ...c, condition: 'GOOD', adding: false, added: false, addError: '' }));
      setMyntraCandidates(candidates);
      setResolvedId(id);
      setMyntraScanId('');
      setRecent((list) => {
        const previous = list.find((r) => r.trackingId === id);
        const items = candidates.map((c, i) => ({
          sku: c.matchedSku ?? c.resolvedSku,
          size: c.size,
          // A rescan keeps what was already added from this tracking id.
          addedCondition: previous && previous.items[i] ? previous.items[i].addedCondition : null,
        }));
        return [{ trackingId: id, items }, ...list.filter((r) => r.trackingId !== id)].slice(0, RECENT_LIMIT);
      });
    } catch (err) {
      setMyntraResolveError(err.message);
    } finally {
      setMyntraResolving(false);
    }
  }

  function handleBarcodeDetected(text) {
    setCameraOpen(false);
    resolveMyntraReturn(text);
  }

  function setCandidateCondition(index, condition) {
    setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, condition } : c)));
  }

  async function addReturnCandidate(index) {
    const candidate = myntraCandidates[index];
    if (!candidate || !candidate.matchedSku || candidate.adding || candidate.added) return;
    setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: true, addError: '' } : c)));
    try {
      const res = await fetch('/api/dashboard/add-return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: candidate.matchedSku, qty: 1, trackingId: resolvedId, condition: candidate.condition }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: false, addError: data.error || `HTTP ${res.status}` } : c)));
        return;
      }
      setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: false, added: true } : c)));
      setRecent((list) => list.map((r) => (r.trackingId === resolvedId
        ? { ...r, items: r.items.map((it, i) => (i === index ? { ...it, addedCondition: candidate.condition } : it)) }
        : r)));
    } catch (err) {
      setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: false, addError: err.message } : c)));
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Scan a Myntra return</h1>
        <p className="muted">
          Scan or type a return tracking ID (MYSR… / MYER… / MYEC…) — resolves the product, size and
          photo the same way stock-manager&apos;s own Returns page does, and logs the return straight
          into stock-manager from here.
        </p>
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            ref={inputRef}
            autoComplete="off"
            value={myntraScanId}
            onChange={(e) => setMyntraScanId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); resolveMyntraReturn(); } }}
            placeholder="MYSR… / MYER… / MYEC…"
            style={{ flex: 1, fontFamily: 'monospace' }}
          />
          <button type="button" onClick={() => resolveMyntraReturn()} disabled={myntraResolving || !myntraScanId.trim()}>
            {myntraResolving ? 'Looking up…' : 'Resolve'}
          </button>
        </div>

        <button
          type="button"
          className="secondary"
          onClick={() => setCameraOpen(true)}
          disabled={myntraResolving}
          style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
        >
          📷 Scan with camera
        </button>

        {myntraResolveError && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{myntraResolveError}</div>}

        {myntraCandidates.length > 0 && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="muted" style={{ fontSize: '0.78rem' }}>
              Found {myntraCandidates.length} item{myntraCandidates.length === 1 ? '' : 's'} for{' '}
              <span style={{ fontFamily: 'monospace' }}>{resolvedId}</span>
            </div>
            {repeatScan && (
              <div className="muted" style={{ fontSize: '0.8rem' }}>You already scanned this one earlier in this session.</div>
            )}
            {myntraCandidates.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
                {c.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.image}
                    alt=""
                    style={{
                      width: 170,
                      maxWidth: '38vw',
                      height: 'auto',
                      maxHeight: 250,
                      borderRadius: 10,
                      objectFit: 'contain',
                      flexShrink: 0,
                    }}
                  />
                ) : null}
                <div style={{ flex: 1, minWidth: 0, fontSize: '0.9rem' }}>
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
                  {c.added && <div style={{ marginTop: 8, color: 'var(--good)', fontWeight: 600 }}>✓ Added</div>}
                  {c.addError && <div style={{ marginTop: 6, color: 'var(--bad)' }}>{c.addError}</div>}
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
                    ? r.items.map((it) => `${it.sku || '?'} · ${it.size || '?'}`).join(', ')
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

      {cameraOpen && <BarcodeScanner onDetected={handleBarcodeDetected} onClose={() => setCameraOpen(false)} />}
    </>
  );
}
