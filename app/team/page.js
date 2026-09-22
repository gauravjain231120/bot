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
  const { isOwner, accounts, accountsError, handleAddAccount, handleDeleteAccount, handleChangeAccountRole } = useDashboard();
  const [newAccountUsername, setNewAccountUsername] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [newAccountRole, setNewAccountRole] = useState('VIEWER');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountFormError, setAccountFormError] = useState('');
  const [roleBusy, setRoleBusy] = useState(null); // username currently being changed, or null

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

  async function onChangeRole(username, role) {
    setRoleBusy(username);
    try {
      await handleChangeAccountRole(username, role);
    } finally {
      setRoleBusy(null);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Dashboard team</h1>
        <p className="muted">Who can log into this dashboard.</p>
      </div>

      <div className="card">
        <h2>Add someone</h2>
        <p className="recipient-hint">
          <b>Owner</b> can do everything, including managing this list. <b>Viewer</b> can log in and
          see the dashboard. Adding, changing a role, or removing someone asks for the
          confirmation password.
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
        {accountFormError && <div className="banner bad" style={{ marginTop: 4 }}>{accountFormError}</div>}
      </div>

      <div className="card">
        <h2>Team members</h2>
        {accountsError && <div className="banner bad">{accountsError}</div>}
        {accounts === null && !accountsError && <p className="muted">Loading…</p>}
        {accounts && accounts.length === 0 && !accountsError && <p className="muted">No accounts yet.</p>}
        {accounts && accounts.length > 0 && (
          <div>
            {accounts.map((a) => {
              const busy = roleBusy === a.username || accountBusy;
              return (
                <div className="recipient-row" key={a.username}>
                  <div className="recipient-info">
                    <div className="recipient-name">
                      {a.username}
                      {a.protected && <span className="muted">protected</span>}
                    </div>
                  </div>
                  <div className="recipient-controls">
                    <div className="role-group">
                      {['OWNER', 'VIEWER'].map((role) => (
                        <button
                          key={role}
                          type="button"
                          className={`role-btn ${role.toLowerCase()} ${a.role === role ? 'active' : ''}`}
                          disabled={busy || a.protected}
                          onClick={() => onChangeRole(a.username, role)}
                        >
                          {role === 'OWNER' ? 'Owner' : 'Viewer'}
                        </button>
                      ))}
                    </div>
                    {!a.protected && (
                      <button
                        type="button"
                        className="remove-btn"
                        disabled={busy}
                        onClick={() => onDelete(a.username)}
                        aria-label={`Remove ${a.username}`}
                        title="Remove"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
