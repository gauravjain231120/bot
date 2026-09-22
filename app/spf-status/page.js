'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDashboard } from '../../lib/DashboardContext';

// Label + display order for every status the getTickets endpoint can return
// (see lib/myntra.js's SPF_TICKET_STATUSES) — kept in the same order there so
// the two stay easy to compare if Myntra ever adds a new one.
const STATUS_LABELS = [
  ['OPEN', 'Open'],
  ['IN_REVIEW', 'In review'],
  ['ACCEPT', 'Approved'],
  ['REJECT', 'Rejected'],
  ['MANUAL', 'Manual'],
  ['INVOICE_CREATED', 'Invoice created'],
  ['INVOICE_INITIATED', 'Invoice initiated'],
  ['PAYMENT_INITIATED', 'Payment initiated'],
  ['PAYMENT_COMPLETED', 'Paid'],
  ['AWAITING_SELLER_RESPONSE', 'Awaiting your response'],
  ['AWAITING_AGENT_RESPONSE', "Awaiting Myntra's response"],
  ['CLOSED', 'Closed'],
  ['DISPUTED', 'Disputed'],
];

function OwnerOnlyNotice() {
  return (
    <div className="card empty-state">
      This page is only available to Owner accounts.
    </div>
  );
}

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// Counts are shown plainly, same as before — the password gate is only for
// the "paid" card's extra ₹ total, computed on demand by
// POST /api/spf-status/verify (see lib/myntra.js's fetchSpfPaidTotal — it's
// not part of the counts this page loads on mount, since the real total costs
// one extra Myntra call per paid ticket to fetch). All four cards still ask
// for the confirmation password on a triple-click, but the other three don't
// reveal anything further — their count was already visible.
const STAT_CARDS = [
  { key: 'total', label: 'Total claims' },
  { key: 'approved', label: 'Approved' },
  { key: 'paid', label: 'Paid' },
  { key: 'rejected', label: 'Rejected' },
];

const MODAL_LABELS = Object.fromEntries(STAT_CARDS.map(({ key, label }) => [key, label]));

export default function SpfStatusPage() {
  const { isOwner } = useDashboard();
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState({});
  const [paidTotal, setPaidTotal] = useState(null);

  // The password modal's own state — a single dialog reused for whichever
  // card was triple-clicked (modalKey), not one instance per card.
  const [modalKey, setModalKey] = useState(null);
  const [modalPassword, setModalPassword] = useState('');
  const [modalError, setModalError] = useState('');
  const [modalBusy, setModalBusy] = useState(false);

  // Deliberately only fires here, on this page — never wired into the main
  // dashboard's poll loop. Fetching this paginates every SPF ticket, a
  // heavier live Myntra call than the other dashboard stats.
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/spf-status');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setCounts(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOwner) load();
  }, [isOwner, load]);

  useEffect(() => {
    if (!modalKey) return;
    function onKeyDown(e) {
      if (e.key === 'Escape') closeModal();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalKey, modalBusy]);

  // A native click event's `detail` is the browser's own consecutive-click
  // counter (1 = single, 2 = double, 3 = triple) — no custom timing/tracking
  // needed. Single and double clicks on a stat card intentionally do nothing.
  function onCardClick(e, key) {
    if (e.detail !== 3) return;
    if (modalBusy || revealed[key]) return;
    setModalKey(key);
    setModalPassword('');
    setModalError('');
  }

  function closeModal() {
    if (modalBusy) return;
    setModalKey(null);
    setModalPassword('');
    setModalError('');
  }

  // Same "second, separate password" pattern as the Team/Recipients pages
  // (DashboardContext's promptAccountPassword/promptRolePassword) — checked
  // server-side (app/api/spf-status/verify), never a client-side-only gate.
  // Only for modalKey === 'paid' does the server actually compute anything
  // (the ₹ total, one extra Myntra call per paid ticket — see
  // lib/myntra.js's fetchSpfPaidTotal) — that's why this can take a few
  // seconds for Paid but is instant for the other three.
  async function onModalSubmit(e) {
    e.preventDefault();
    setModalBusy(true);
    setModalError('');
    try {
      const res = await fetch('/api/spf-status/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmPassword: modalPassword, key: modalKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setModalError(data.error || `HTTP ${res.status}`);
        return;
      }
      if (modalKey === 'paid') setPaidTotal(data.paidTotalAmount || 0);
      setRevealed((prev) => ({ ...prev, [modalKey]: true }));
      setModalKey(null);
      setModalPassword('');
    } finally {
      setModalBusy(false);
    }
  }

  if (!isOwner) return <OwnerOnlyNotice />;

  const breakdown = counts
    ? STATUS_LABELS.map(([key, label]) => [label, counts.byStatus[key] || 0]).filter(([, n]) => n > 0)
    : [];

  const statNumbers = counts
    ? {
        total: counts.total,
        approved: counts.byStatus.ACCEPT || 0,
        paid: counts.byStatus.PAYMENT_COMPLETED || 0,
        rejected: counts.byStatus.REJECT || 0,
      }
    : {};

  return (
    <>
      <div className="page-header">
        <h1>SPF Claim Status</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <p className="muted" style={{ margin: 0 }}>Total claims, and where each one stands.</p>
          <button type="button" className="secondary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="banner bad">{error}</div>}

      {counts && (
        <>
          <div className="stat-grid">
            {STAT_CARDS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className="stat-card clickable"
                onClick={(e) => onCardClick(e, key)}
              >
                <div className="stat-label">{label}</div>
                <div className="stat-value">{statNumbers[key]}</div>
                {key === 'paid' && revealed.paid && (
                  <div className="stat-sub">{INR.format(paidTotal || 0)} paid total</div>
                )}
              </button>
            ))}
          </div>

          {breakdown.length > 0 && (
            <div className="card">
              <h2>Full breakdown</h2>
              <div>
                {breakdown.map(([label, n]) => (
                  <div
                    key={label}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '8px 0',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    <span>{label}</span>
                    <span style={{ fontWeight: 600 }}>{n}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {!counts && !error && loading && <p className="muted">Loading…</p>}

      {modalKey && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={onModalSubmit}>
              <h2>Confirm to reveal “{MODAL_LABELS[modalKey]}”</h2>
              <p className="muted">
                {modalKey === 'paid'
                  ? 'Enter the confirmation password to calculate and show the total amount paid.'
                  : 'Enter the confirmation password to continue.'}
              </p>
              <label htmlFor="spf-modal-password">Confirmation password</label>
              <input
                id="spf-modal-password"
                type="password"
                value={modalPassword}
                onChange={(e) => setModalPassword(e.target.value)}
                autoFocus
                disabled={modalBusy}
              />
              {modalError && <p className="error" style={{ marginTop: 8 }}>{modalError}</p>}
              {modalBusy && modalKey === 'paid' && (
                <p className="muted" style={{ marginTop: 8 }}>Calculating total, this can take a few seconds…</p>
              )}
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={closeModal} disabled={modalBusy}>
                  Cancel
                </button>
                <button type="submit" disabled={modalBusy || !modalPassword}>
                  {modalBusy ? 'Checking…' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
