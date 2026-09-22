'use client';

import { useState } from 'react';
import { useDashboard } from '../../lib/DashboardContext';

function OwnerOnlyNotice() {
  return (
    <div className="card empty-state">
      This page is only available to Owner accounts.
    </div>
  );
}

export default function TeamPage() {
  const { isOwner, accounts, accountsError, handleAddAccount, handleDeleteAccount } = useDashboard();
  const [newAccountUsername, setNewAccountUsername] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [newAccountRole, setNewAccountRole] = useState('VIEWER');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountFormError, setAccountFormError] = useState('');

  if (!isOwner) return <OwnerOnlyNotice />;

  async function onSubmit(e) {
    e.preventDefault();
    setAccountFormError('');
    setAccountBusy(true);
    try {
      await handleAddAccount({ username: newAccountUsername, password: newAccountPassword, role: newAccountRole });
      setNewAccountUsername('');
      setNewAccountPassword('');
      setNewAccountRole('VIEWER');
    } catch (err) {
      setAccountFormError(err.message);
    } finally {
      setAccountBusy(false);
    }
  }

  async function onDelete(name) {
    setAccountBusy(true);
    try {
      await handleDeleteAccount(name);
    } finally {
      setAccountBusy(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Dashboard team</h1>
        <p className="muted">Who can log into this dashboard.</p>
      </div>

      <div className="card">
        <p className="recipient-hint">
          <b>Owner</b> can do everything, including managing this list. <b>Viewer</b> can log in and
          see the dashboard.
        </p>

        <form onSubmit={onSubmit} className="form-grid">
          <label className="field">
            Username
            <input
              value={newAccountUsername}
              onChange={(e) => setNewAccountUsername(e.target.value)}
              placeholder="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
          </label>
          <label className="field">
            Password
            <input
              type="password"
              value={newAccountPassword}
              onChange={(e) => setNewAccountPassword(e.target.value)}
              placeholder="at least 8 characters"
              required
            />
          </label>
          <label className="field">
            Role
            <select value={newAccountRole} onChange={(e) => setNewAccountRole(e.target.value)}>
              <option value="VIEWER">Viewer</option>
              <option value="OWNER">Owner</option>
            </select>
          </label>
          <button type="submit" disabled={accountBusy}>
            {accountBusy ? 'Adding…' : 'Add'}
          </button>
        </form>
        {accountFormError && <div className="banner bad" style={{ marginBottom: 14 }}>{accountFormError}</div>}

        {accountsError && <div className="banner bad">{accountsError}</div>}
        {accounts === null && !accountsError && <p className="muted">Loading…</p>}
        {accounts && accounts.length > 0 && (
          <div>
            {accounts.map((a) => (
              <div className="recipient-row" key={a.username}>
                <div className="recipient-info">
                  <div className="recipient-name">{a.username}</div>
                  <div className="recipient-meta">
                    <span className={`role-btn ${a.role.toLowerCase()} active`} style={{ pointerEvents: 'none' }}>
                      {a.role === 'OWNER' ? 'Owner' : 'Viewer'}
                    </span>
                  </div>
                </div>
                <div className="recipient-controls">
                  {!a.protected && (
                    <button
                      type="button"
                      className="remove-btn"
                      disabled={accountBusy}
                      onClick={() => onDelete(a.username)}
                      aria-label={`Remove ${a.username}`}
                      title="Remove"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
