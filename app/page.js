'use client';

import { useCallback, useEffect, useState } from 'react';

const REFRESH_MS = 20000;

function timeAgo(iso) {
  if (!iso) return 'never';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(iso).toLocaleDateString();
}

function SunIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function RefreshIcon({ spinning }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={spinning ? { animation: 'spin 0.8s linear infinite' } : undefined}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function SkeletonOrderCard() {
  return (
    <div className="skeleton-card">
      <div className="order-card-image skeleton" />
      <div className="skeleton-line skeleton" />
      <div className="skeleton-line short skeleton" />
    </div>
  );
}

export default function AdminPage() {
  const [authed, setAuthed] = useState(null); // null = loading
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [orders, setOrders] = useState(null);
  const [ordersError, setOrdersError] = useState('');
  const [curlText, setCurlText] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [checking, setChecking] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [theme, setTheme] = useState(null);

  useEffect(() => {
    let initial = 'light';
    try {
      initial = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } catch {
      // localStorage/matchMedia unavailable — fall back to light
    }
    setTheme(initial);
    document.documentElement.setAttribute('data-theme', initial);
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      // ignore
    }
  }

  const loadStatus = useCallback(async () => {
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
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/orders');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOrdersError(data.error || `HTTP ${res.status}`);
        setOrders([]);
        return;
      }
      setOrders(data.orders || []);
      setOrdersError('');
    } catch (err) {
      setOrdersError(err.message);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (authed !== true) return;
    loadOrders();
    const interval = setInterval(() => {
      loadStatus();
      loadOrders();
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [authed, loadStatus, loadOrders]);

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
    loadOrders();
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
    loadStatus();
    loadOrders();
  }

  async function handleToggle() {
    setToggling(true);
    const endpoint = status?.running ? '/api/admin/stop' : '/api/admin/start';
    const res = await fetch(endpoint, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    setToggling(false);
    if (!res.ok) {
      alert(`Could not toggle: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    loadStatus();
    loadOrders();
  }

  if (authed === null) {
    return (
      <main className="center-wrap">
        <p>Loading...</p>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="center-wrap">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h1>Myntra Order Alerts</h1>
          {theme && (
            <button type="button" className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          )}
        </div>
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

  const running = Boolean(status?.running);

  return (
    <main className="wrap">
      <div className="topbar">
        <h1>Myntra Order Alerts</h1>
        <div className="topbar-controls">
          <span className={`pill ${running ? 'live' : 'stopped'}`}>
            <span className="pill-dot" />
            {running ? 'Live' : 'Stopped'}
          </span>
          <button className={running ? 'danger' : ''} onClick={handleToggle} disabled={toggling}>
            {running ? <StopIcon /> : <PlayIcon />}
            {toggling ? 'Working...' : running ? 'Stop' : 'Start'}
          </button>
          <button className="secondary" onClick={handleCheckNow} disabled={checking}>
            <RefreshIcon spinning={checking} />
            {checking ? 'Checking...' : 'Check now'}
          </button>
          {theme && (
            <button type="button" className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
          )}
        </div>
      </div>

      {loadError && <div className="banner bad">Could not load status: {loadError}</div>}
      {status?.lastError && <div className="banner bad">New-order check error: {status.lastError}</div>}
      {status?.lastCancelError && (
        <div className="banner bad">Cancellation check error: {status.lastCancelError}</div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Open orders</div>
          <div className="stat-value">{status?.openCount ?? '—'}</div>
          <div className="stat-sub">checked {timeAgo(status?.lastCheck)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Recently cancelled</div>
          <div className="stat-value">{status?.cancelledCount ?? '—'}</div>
          <div className="stat-sub">last 15 seen · checked {timeAgo(status?.lastCancelCheck)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Session</div>
          <div className="stat-value" style={{ fontSize: '1rem' }}>
            {status?.sessionCapturedAt ? 'Active' : 'Not set'}
          </div>
          <div className="stat-sub">captured {timeAgo(status?.sessionCapturedAt)}</div>
        </div>
      </div>

      <div className="section-title">
        <h2>Open orders</h2>
        <span className="muted">{orders ? `${orders.length} order${orders.length === 1 ? '' : 's'}` : ''}</span>
      </div>

      {ordersError && <div className="banner bad">Could not load orders: {ordersError}</div>}

      {orders === null && !ordersError && (
        <div className="order-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonOrderCard key={i} />
          ))}
        </div>
      )}

      {orders && orders.length === 0 && !ordersError && (
        <div className="card empty-state">No open orders right now.</div>
      )}

      {orders && orders.length > 0 && (
        <div className="order-grid">
          {orders.flatMap((order) =>
            order.items.length > 0
              ? order.items.map((item, i) => (
                  <div className="order-card" key={`${order.orderId}-${i}`}>
                    {item.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="order-card-image" src={item.image} alt={item.name || 'Product'} />
                    ) : (
                      <div className="order-card-image" />
                    )}
                    <div className="order-card-body">
                      <div className="order-card-name">{item.name || 'Unnamed product'}</div>
                      <div className="order-card-meta">
                        {item.size ? `Size ${item.size}` : ''}
                        {item.color ? ` · ${item.color}` : ''}
                      </div>
                      {item.sku && <span className="sku-tag">{item.sku}</span>}
                      <div className="order-card-footer">
                        <span>#{order.orderId}</span>
                        <span>{order.orderDate ? new Date(order.orderDate).toLocaleDateString() : ''}</span>
                      </div>
                    </div>
                  </div>
                ))
              : [
                  <div className="order-card" key={order.orderId}>
                    <div className="order-card-image" />
                    <div className="order-card-body">
                      <div className="order-card-name">Order #{order.orderId}</div>
                      <div className="order-card-meta">Qty {order.quantity ?? '?'}</div>
                      <div className="order-card-footer">
                        <span>{order.orderDate ? new Date(order.orderDate).toLocaleString() : ''}</span>
                      </div>
                    </div>
                  </div>,
                ]
          )}
        </div>
      )}

      <details className="card">
        <summary>Refresh Myntra session</summary>
        <p>
          DevTools → Network → right-click a partnersapi.myntrainfo.com/api/mdirect/orders request →
          Copy → Copy as cURL. Paste the whole thing below.
        </p>
        <form onSubmit={handleSaveSession}>
          <textarea
            rows={6}
            value={curlText}
            onChange={(e) => setCurlText(e.target.value)}
            placeholder="curl --url 'https://partnersapi.myntrainfo.com/...' -H '...' -b '...' ..."
          />
          <button type="submit">Save session</button>
        </form>
        {saveMsg && <p>{saveMsg}</p>}
      </details>
    </main>
  );
}
