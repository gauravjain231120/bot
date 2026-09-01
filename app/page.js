'use client';

import { useEffect, useState } from 'react';

export default function AdminPage() {
  const [authed, setAuthed] = useState(null); // null = loading
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [status, setStatus] = useState(null);
  const [curlText, setCurlText] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [checking, setChecking] = useState(false);
  const [loadError, setLoadError] = useState('');

  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLoadError(data.error || `Status check failed (HTTP ${res.status})`);
        setAuthed(true);
        return;
      }
      const data = await res.json();
      setStatus(data);
      setLoadError('');
      setAuthed(true);
    } catch (err) {
      setLoadError(`Could not reach the server: ${err.message}`);
      setAuthed(true);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError('');
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      setLoginError('Wrong password');
      return;
    }
    setPassword('');
    loadStatus();
  }

  async function handleSaveSession(e) {
    e.preventDefault();
    setSaveMsg('Saving...');
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curl: curlText }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSaveMsg(`Error: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    setSaveMsg(`Saved ${data.headerCount} headers.`);
    setCurlText('');
    loadStatus();
  }

  async function handleCheckNow() {
    setChecking(true);
    const res = await fetch('/api/admin/check-now', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    setChecking(false);
    if (!res.ok) {
      alert(`Check failed: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    alert(`Checked: ${data.openCount} open orders, ${data.newCount} new.`);
    loadStatus();
  }

  if (authed === null) {
    return (
      <main className="wrap">
        <p>Loading...</p>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="wrap">
        <h1>Myntra Order Alerts</h1>
        <form onSubmit={handleLogin} className="card">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <button type="submit">Log in</button>
          {loginError && <p className="error">{loginError}</p>}
        </form>
      </main>
    );
  }

  return (
    <main className="wrap">
      <h1>Myntra Order Alerts</h1>

      <section className="card">
        <h2>Status</h2>
        {loadError && <p className="error">Could not load status: {loadError}</p>}
        <p>
          Session captured:{' '}
          {status?.sessionCapturedAt ? new Date(status.sessionCapturedAt).toLocaleString() : 'never'}
        </p>
        <p>Last check: {status?.lastCheck ? new Date(status.lastCheck).toLocaleString() : 'never'}</p>
        <p>Currently open orders: {status?.openCount ?? '—'}</p>
        {status?.lastError && <p className="error">Last error: {status.lastError}</p>}
        <button onClick={handleCheckNow} disabled={checking}>
          {checking ? 'Checking...' : 'Check now'}
        </button>
      </section>

      <section className="card">
        <h2>Refresh session</h2>
        <p>
          DevTools → Network → right-click a partnersapi.myntrainfo.com/api/mdirect/orders request →
          Copy → Copy as cURL. Paste the whole thing below.
        </p>
        <form onSubmit={handleSaveSession}>
          <textarea
            rows={6}
            value={curlText}
            onChange={(e) => setCurlText(e.target.value)}
            placeholder="curl 'https://partnersapi.myntrainfo.com/...' -H '...' ..."
          />
          <button type="submit">Save session</button>
        </form>
        {saveMsg && <p>{saveMsg}</p>}
      </section>
    </main>
  );
}
