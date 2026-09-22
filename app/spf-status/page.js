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
// the "paid" card's extra ₹ total (counts.paidTotalAmount, summed
// server-side in lib/myntra.js's fetchSpfTicketCounts() from each ticket's
// meta.finalAmount, no extra Myntra call). All four cards stay clickable and
// still ask for the confirmation password, but the other three don't reveal
// anything further — their count was already visible.
const STAT_CARDS = [
  { key: 'total', label: 'Total claims' },
  { key: 'approved', label: 'Approved' },
  { key: 'paid', label: 'Paid' },
  { key: 'rejected', label: 'Rejected' },
];

export default function SpfStatusPage() {
  const { isOwner } = useDashboard();
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState({});
  const [revealBusy, setRevealBusy] = useState(null);

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

  // Same "second, separate password" pattern as the Team/Recipients pages
  // (DashboardContext's promptAccountPassword/promptRolePassword) — checked
  // server-side (app/api/spf-status/verify), never a client-side-only gate.
  async function onReveal(key) {
    if (revealed[key]) return;
    const confirmPassword = window.prompt('Enter the confirmation password to continue:');
    if (confirmPassword === null) return; // cancelled
    setRevealBusy(key);
    try {
      const res = await fetch('/api/spf-status/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Could not reveal: ${data.error || `HTTP ${res.status}`}`);
        return;
      }
      setRevealed((prev) => ({ ...prev, [key]: true }));
    } finally {
      setRevealBusy(null);
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
            {STAT_CARDS.map(({ key, label }) => {
              const busy = revealBusy === key;
              return (
                <button
                  key={key}
                  type="button"
                  className="stat-card clickable"
                  onClick={() => onReveal(key)}
                  disabled={busy}
                >
                  <div className="stat-label">{label}</div>
                  <div className="stat-value">{statNumbers[key]}</div>
                  {key === 'paid' && revealed.paid && (
                    <div className="stat-sub">{INR.format(counts.paidTotalAmount || 0)} paid total</div>
                  )}
                </button>
              );
            })}
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
    </>
  );
}
