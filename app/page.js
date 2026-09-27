'use client';

import { useDashboard } from '../lib/DashboardContext';
import { timeAgo, formatMinutes, otcLines } from '../lib/format';
import { OrdersGrid } from '../components/OrdersGrid';
import { OtcWindowEditor } from '../components/OtcWindowEditor';

export default function OverviewPage() {
  const { status, loadError, isOwner, otcStatus, otcClearing, handleClearOtc, handleSetOtcWindow, packedCount, packedCountError, packedLoading, loadPackedCount } = useDashboard();

  return (
    <>
      <div className="page-header">
        <h1>Overview</h1>
        <p className="muted">Live status across Myntra, Amazon and pickup/return alerts.</p>
      </div>

      {loadError && <div className="banner bad">Could not load status: {loadError}</div>}
      {status?.lastError && <div className="banner bad">Myntra check error: {status.lastError}</div>}
      {status?.lastCancelError && (
        <div className="banner bad">Myntra cancellation check error: {status.lastCancelError}</div>
      )}
      {status?.amazonLastError && <div className="banner bad">Amazon check error: {status.amazonLastError}</div>}
      {status?.amazonLastCancelError && (
        <div className="banner bad">Amazon cancellation check error: {status.amazonLastCancelError}</div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Myntra open orders</div>
          <div className="stat-value">{status?.openCount ?? '—'}</div>
          <div className="stat-sub">checked {timeAgo(status?.lastCheck)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Myntra recently cancelled</div>
          <div className="stat-value">{status?.cancelledCount ?? '—'}</div>
          <div className="stat-sub">last 15 seen · checked {timeAgo(status?.lastCancelCheck)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Amazon open orders</div>
          <div className="stat-value">{status?.amazonOpenCount ?? '—'}</div>
          <div className="stat-sub">checked {timeAgo(status?.amazonLastCheck)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Amazon recently cancelled</div>
          <div className="stat-value">{status?.amazonCancelledCount ?? '—'}</div>
          <div className="stat-sub">last 15 seen · checked {timeAgo(status?.amazonLastCancelCheck)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Sessions</div>
          <div className="stat-value" style={{ fontSize: '0.95rem' }}>
            M: {status?.sessionCapturedAt ? 'Active' : 'Not set'} · A: {status?.amazonSessionCapturedAt ? 'Active' : 'Not set'}
          </div>
          <div className="stat-sub">
            {status?.sessionCapturedAt ? timeAgo(status.sessionCapturedAt) : '—'} /{' '}
            {status?.amazonSessionCapturedAt ? timeAgo(status.amazonSessionCapturedAt) : '—'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pickup/Return OTC</div>
          {otcStatus?.values ? (
            <>
              <div className="stat-value" style={{ fontSize: '0.95rem', lineHeight: 1.5 }}>
                {otcLines(otcStatus.values).map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
              <div className="stat-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                found {timeAgo(otcStatus.alertedAt)}
                <button
                  type="button"
                  className="secondary"
                  style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                  onClick={handleClearOtc}
                  disabled={otcClearing}
                >
                  {otcClearing ? 'Clearing…' : 'Clear'}
                </button>
              </div>
            </>
          ) : otcStatus?.clearedToday ? (
            <>
              <div className="stat-value">Cleared</div>
              <div className="stat-sub">won&apos;t check again today</div>
            </>
          ) : otcStatus?.windowActive ? (
            <>
              <div className="stat-value">Checking…</div>
              <div className="stat-sub">window closes in {formatMinutes(otcStatus.minutesToWindowChange)}</div>
            </>
          ) : otcStatus ? (
            <>
              <div className="stat-value">Not active</div>
              <div className="stat-sub">opens in {formatMinutes(otcStatus.minutesToWindowChange)}</div>
            </>
          ) : (
            <div className="stat-value">—</div>
          )}
          <OtcWindowEditor window={otcStatus?.window} isOwner={isOwner} onSave={handleSetOtcWindow} />
        </div>
        <div className="stat-card">
          {/* Packets waiting for pickup among those packed in the last 4 days (api/packed-count). */}
          <div className="stat-label">Myntra packed</div>
          {packedCountError ? (
            <>
              <div className="stat-value" style={{ fontSize: '0.85rem' }}>Error</div>
              <div className="stat-sub">{packedCountError}</div>
            </>
          ) : (
            <div className="stat-value">
              {packedCount ? `${packedCount.count}${packedCount.capped ? '+' : ''}` : packedLoading ? '…' : '—'}
            </div>
          )}
          <div className="stat-sub" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            {packedCount && !packedCountError ? (
              <span>
                waiting for pickup (last {packedCount.days || 4} days)
                {packedCount.today != null ? ` · ${packedCount.today} packed today` : ''}
                {packedCount.todayPicked ? ` (${packedCount.todayPicked} picked up)` : ''}
                {packedCount.overdue ? (
                  <span
                    style={{ display: 'block', color: 'var(--bad)', fontWeight: 600 }}
                    title={(packedCount.overdueIds || []).join(', ')}
                  >
                    {packedCount.overdue} past pick-by time{packedCount.overdueIds && packedCount.overdueIds.length ? `: ${packedCount.overdueIds.join(', ')}` : ''}
                  </span>
                ) : null}
              </span>
            ) : null}
            <button
              type="button"
              className="secondary"
              style={{ padding: '2px 8px', fontSize: '0.72rem' }}
              onClick={() => loadPackedCount(true)}
              disabled={packedLoading}
            >
              {packedLoading ? 'Checking…' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      <OrdersGrid />
    </>
  );
}
