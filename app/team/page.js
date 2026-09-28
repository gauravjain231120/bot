'use client';

import { useState } from 'react';
import { useDashboard } from '../../lib/DashboardContext';
import { SECTIONS, DEFAULT_VIEWER_SECTIONS, cleanSections } from '../../lib/sections';

function OwnerOnlyNotice() {
  return (
    <div className="card empty-state">
      This page is only available to Owner accounts.
    </div>
  );
}

// One tick box per section a Viewer can be given (lib/sections.js). Team
// itself is never on it — only Owners manage who can log in.
function SectionPicker({ value, onChange, disabled }) {
  const set = new Set(value);
  const toggle = (key) => onChange(cleanSections(set.has(key) ? value.filter((k) => k !== key) : [...value, key]));
  return (
    <div className="section-picks">
      {SECTIONS.map((s) => (
        <label key={s.key} className={`section-pick ${set.has(s.key) ? 'on' : ''}`} title={s.hint || ''}>
          <input type="checkbox" checked={set.has(s.key)} disabled={disabled} onChange={() => toggle(s.key)} />
          {s.label}
        </label>
      ))}
    </div>
  );
}

// What a Viewer row saves: the ticks shown, which start as what's stored
// (none stored yet = the old default every Viewer had).
const storedSections = (a) => (Array.isArray(a.sections) ? cleanSections(a.sections) : [...DEFAULT_VIEWER_SECTIONS]);
const sameList = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

function MemberSections({ member, busy, onSave }) {
  const stored = storedSections(member);
  const [draft, setDraft] = useState(null); // null = showing what's stored
  const shown = draft || stored;
  const changed = draft && !sameList(draft, stored);
  return (
    <div className="member-sections">
      <span className="muted member-sections-label">
        Can open{Array.isArray(member.sections) ? '' : ' (the standard set — not chosen yet)'}:
      </span>
      <SectionPicker value={shown} onChange={setDraft} disabled={busy} />
      {changed && (
        <div className="member-sections-actions">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (await onSave(member.username, draft)) setDraft(null);
            }}
          >
            Save
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => setDraft(null)}>
            Undo
          </button>
          {draft.length === 0 && <span className="muted">Nothing ticked — they can log in but open nothing.</span>}
        </div>
      )}
    </div>
  );
}

export default function TeamPage() {
  const {
    isOwner, accounts, accountsError,
    handleAddAccount, handleDeleteAccount, handleChangeAccountRole, handleSetAccountSections,
  } = useDashboard();
  const [newAccountUsername, setNewAccountUsername] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [newAccountRole, setNewAccountRole] = useState('VIEWER');
  const [newAccountSections, setNewAccountSections] = useState([...DEFAULT_VIEWER_SECTIONS]);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountFormError, setAccountFormError] = useState('');
  const [roleBusy, setRoleBusy] = useState(null); // username currently being changed, or null

  if (!isOwner) return <OwnerOnlyNotice />;

  async function onSubmit(e) {
    e.preventDefault();
    setAccountFormError('');
    setAccountBusy(true);
    try {
      const added = await handleAddAccount({
        username: newAccountUsername,
        password: newAccountPassword,
        role: newAccountRole,
        sections: newAccountSections,
      });
      if (added) {
        setNewAccountUsername('');
        setNewAccountPassword('');
        setNewAccountRole('VIEWER');
        setNewAccountSections([...DEFAULT_VIEWER_SECTIONS]);
      }
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

  async function onSaveSections(username, sections) {
    setRoleBusy(username);
    try {
      return await handleSetAccountSections(username, sections);
    } finally {
      setRoleBusy(null);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Dashboard team</h1>
        <p className="muted">Who can log into this dashboard, and what each person can open.</p>
      </div>

      <div className="card">
        <h2>Add someone</h2>
        <p className="recipient-hint">
          <b>Owner</b> can do everything, including managing this list. <b>Viewer</b> can open only
          the pages you tick for them — everything else is hidden and locked for them. Adding,
          changing a role or what someone can open, or removing someone asks for the confirmation
          password.
        </p>

        <form onSubmit={onSubmit}>
          <div className="form-grid">
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
          </div>
          {newAccountRole === 'VIEWER' ? (
            <div className="member-sections" style={{ marginBottom: 12 }}>
              <span className="muted member-sections-label">Can open:</span>
              <SectionPicker value={newAccountSections} onChange={setNewAccountSections} disabled={accountBusy} />
            </div>
          ) : (
            <p className="muted" style={{ marginTop: 0 }}>An Owner can open everything.</p>
          )}
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
                <div className="recipient-row member-row" key={a.username}>
                  <div className="recipient-info">
                    <div className="recipient-name">
                      {a.username}
                      {a.protected && <span className="muted">protected</span>}
                    </div>
                    {a.role === 'OWNER' && <div className="recipient-meta">Can open everything</div>}
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
                  {a.role === 'VIEWER' && (
                    // Keyed by what's stored, so a saved change (or one made elsewhere) resets the draft.
                    <MemberSections key={storedSections(a).join(',')} member={a} busy={busy} onSave={onSaveSections} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
