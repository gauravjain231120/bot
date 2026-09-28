'use client';

import { useDashboard } from '../../lib/DashboardContext';
import { timeAgo } from '../../lib/format';
import { RefreshIcon } from '../../components/icons';

function NoAccessNotice() {
  return (
    <div className="card empty-state">
      You don&apos;t have access to this page — ask the Owner to give it to you on the Team page.
    </div>
  );
}

export default function RecipientsPage() {
  const {
    can,
    recipients, recipientsError, botUsername, roleBusy, recipientsRefreshing,
    handleRefreshRecipients, handleSetRole, handleRemoveRecipient,
    roleHistory,
    otcScope, otcScopeBusy, handleSetOtcScope,
  } = useDashboard();

  if (!can('recipients')) return <NoAccessNotice />;

  return (
    <>
      <div className="page-header">
        <h1>Alert recipients</h1>
        <p className="muted">Who gets alerted on Telegram, and the audit trail of role changes.</p>
      </div>

      <div className="card">
        <p className="recipient-hint">
          {botUsername ? (
            <>
              Have someone message <code>@{botUsername}</code> on Telegram — they&apos;ll show up below
              automatically. Then pick their role.
            </>
          ) : (
            <>Have someone message this bot on Telegram — they&apos;ll show up below automatically. Then pick their role.</>
          )}
          {' '}
          <b>Owner</b> gets every alert. <b>Viewer</b> gets new order + cancellation alerts only. <b>None</b> gets nothing.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>Pickup/return OTC alert goes to:</span>
          <div className="role-group">
            <button
              type="button"
              className={`role-btn owner ${otcScope === 'OWNER' ? 'active' : ''}`}
              disabled={otcScopeBusy || otcScope === null}
              onClick={() => handleSetOtcScope('OWNER')}
            >
              Owner
            </button>
            <button
              type="button"
              className={`role-btn viewer ${otcScope === 'BROADCAST' ? 'active' : ''}`}
              disabled={otcScopeBusy || otcScope === null}
              onClick={() => handleSetOtcScope('BROADCAST')}
            >
              Viewer
            </button>
          </div>
          <span className="muted" style={{ fontSize: '0.78rem' }}>
            {otcScope === 'BROADCAST' ? '(you + everyone with a role)' : '(only you)'}
          </span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <button type="button" className="secondary" onClick={handleRefreshRecipients} disabled={recipientsRefreshing}>
            <RefreshIcon spinning={recipientsRefreshing} />
            {recipientsRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {recipientsError && <div className="banner bad">{recipientsError}</div>}

        {recipients === null && !recipientsError && <p className="muted">Loading…</p>}

        {recipients && recipients.length === 0 && !recipientsError && (
          <p className="muted">No one has messaged the bot yet.</p>
        )}

        {recipients && recipients.length > 0 && (
          <div>
            {recipients.map((r) => {
              const busy = roleBusy === r.chatId;
              return (
                <div className="recipient-row" key={r.chatId}>
                  <div className="recipient-info">
                    <div className="recipient-name">
                      {r.name || 'Unknown'}
                      {r.username && <span className="muted">@{r.username}</span>}
                    </div>
                    <div className="recipient-meta">
                      <span className="sku-tag">{r.chatId}</span>
                      <span>last seen {timeAgo(r.lastSeenAt)}</span>
                    </div>
                  </div>
                  <div className="recipient-controls">
                    <div className="role-group">
                      {['OWNER', 'VIEWER', 'NONE'].map((role) => (
                        <button
                          key={role}
                          type="button"
                          className={`role-btn ${role.toLowerCase()} ${r.role === role ? 'active' : ''}`}
                          disabled={busy}
                          onClick={() => handleSetRole(r.chatId, role)}
                        >
                          {role === 'OWNER' ? 'Owner' : role === 'VIEWER' ? 'Viewer' : 'None'}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="remove-btn"
                      disabled={busy}
                      onClick={() => handleRemoveRecipient(r.chatId, r.name)}
                      aria-label={`Remove ${r.name || r.chatId}`}
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Role change history</h2>
        {roleHistory === null && <p className="muted">Loading…</p>}
        {roleHistory && roleHistory.length === 0 && (
          <p className="muted">No role changes yet — this starts tracking from the next one.</p>
        )}
        {roleHistory && roleHistory.length > 0 && (
          <div>
            {roleHistory.map((h, i) => (
              <div className="history-row" key={`${h.chatId}-${h.changedAt}-${i}`}>
                <span>{h.name || h.chatId}</span>
                <span className="muted">
                  {h.fromRole === 'NONE' ? 'None' : h.fromRole === 'OWNER' ? 'Owner' : 'Viewer'} →{' '}
                  {h.toRole === 'NONE' ? 'None' : h.toRole === 'OWNER' ? 'Owner' : 'Viewer'}
                </span>
                <span className="muted">{timeAgo(h.changedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
