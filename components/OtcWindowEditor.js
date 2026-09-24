'use client';

import { useState } from 'react';
import { formatHm } from '../lib/format';

/**
 * The OTC card's check-window line: "Checks 12:00 pm – 1:00 pm IST", plus an
 * Owner-only "Change" that opens two time pickers inline. Times are India
 * time (IST) whatever timezone the phone/PC is in — the server stores and
 * compares plain "HH:MM" IST, so nothing here converts timezones.
 */
export function OtcWindowEditor({ window: win, isOwner, onSave }) {
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!win) return null;

  function open() {
    setStart(win.start);
    setEnd(win.end);
    setError('');
    setEditing(true);
  }

  async function save(e) {
    e.preventDefault();
    if (!start || !end) {
      setError('Pick both times.');
      return;
    }
    if (end <= start) {
      setError('End time must be later than start time.');
      return;
    }
    setBusy(true);
    const r = await onSave(start, end);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="stat-sub" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        Checks {formatHm(win.start)} – {formatHm(win.end)} IST
        {isOwner && (
          <button type="button" className="secondary" style={{ padding: '2px 8px', fontSize: '0.72rem' }} onClick={open}>
            Change
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={save} className="stat-sub" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 110px', minWidth: 0 }}>
          <span>Start (IST)</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} required step={60} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: '1 1 110px', minWidth: 0 }}>
          <span>End (IST)</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required step={60} />
        </label>
      </div>
      {error && <div style={{ color: 'var(--bad)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" style={{ padding: '4px 12px', fontSize: '0.8rem' }} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="secondary" style={{ padding: '4px 12px', fontSize: '0.8rem' }} onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      <div className="muted" style={{ fontSize: '0.72rem' }}>
        India time, same day. 5 min to 8 hours. Checks every ~2 min inside it and stops once a code is found.
      </div>
    </form>
  );
}
