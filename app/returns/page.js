'use client';

import { useState } from 'react';
import { BarcodeScanner } from '../../components/BarcodeScanner';
import { RETURN_CONDITIONS, RETURN_CONDITION_LABELS } from '../../lib/format';

export default function ReturnsPage() {
  const [myntraScanId, setMyntraScanId] = useState('');
  const [myntraResolving, setMyntraResolving] = useState(false);
  const [myntraResolveError, setMyntraResolveError] = useState('');
  const [myntraCandidates, setMyntraCandidates] = useState([]);
  const [cameraOpen, setCameraOpen] = useState(false);

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
    if (!id) return;
    setMyntraScanId(id);
    setMyntraResolving(true);
    setMyntraResolveError('');
    setMyntraCandidates([]);
    try {
      const res = await fetch(`/api/dashboard/resolve-return?trackingId=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMyntraResolveError(data.error || `HTTP ${res.status}`);
        return;
      }
      const candidates = (data.candidates || []).map((c) => ({ ...c, condition: 'GOOD', adding: false, added: false, addError: '' }));
      setMyntraCandidates(candidates);
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
        body: JSON.stringify({ sku: candidate.matchedSku, qty: 1, trackingId: myntraScanId, condition: candidate.condition }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: false, addError: data.error || `HTTP ${res.status}` } : c)));
        return;
      }
      setMyntraCandidates((list) => list.map((c, i) => (i === index ? { ...c, adding: false, added: true } : c)));
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
            value={myntraScanId}
            onChange={(e) => setMyntraScanId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); resolveMyntraReturn(); } }}
            placeholder="MYSR… / MYER… / MYEC…"
            style={{ flex: 1, fontFamily: 'monospace' }}
          />
          <button type="button" className="secondary" onClick={() => setCameraOpen(true)} disabled={myntraResolving} title="Scan with camera" aria-label="Scan with camera">
            📷
          </button>
          <button type="button" onClick={() => resolveMyntraReturn()} disabled={myntraResolving || !myntraScanId.trim()}>
            {myntraResolving ? 'Looking up…' : 'Resolve'}
          </button>
        </div>

        {myntraResolveError && <div className="banner bad" style={{ marginTop: 12, marginBottom: 0 }}>{myntraResolveError}</div>}

        {myntraCandidates.length > 0 && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="muted" style={{ fontSize: '0.78rem' }}>
              Found {myntraCandidates.length} item{myntraCandidates.length === 1 ? '' : 's'} for this tracking ID
            </div>
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

      {cameraOpen && <BarcodeScanner onDetected={handleBarcodeDetected} onClose={() => setCameraOpen(false)} />}
    </>
  );
}
