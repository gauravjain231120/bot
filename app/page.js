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

function formatDuration(ms) {
  if (ms == null) return null;
  const totalMin = Math.round(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
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

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
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
  const [amazonCurlText, setAmazonCurlText] = useState('');
  const [amazonSaveMsg, setAmazonSaveMsg] = useState('');
  const [checking, setChecking] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [theme, setTheme] = useState(null);
  const [fSource, setFSource] = useState('all');
  const [sessionHistory, setSessionHistory] = useState(null);
  const [recipients, setRecipients] = useState(null);
  const [recipientsError, setRecipientsError] = useState('');
  const [botUsername, setBotUsername] = useState(null);
  const [roleBusy, setRoleBusy] = useState(null); // chatId currently being updated, or null
  const [recipientsRefreshing, setRecipientsRefreshing] = useState(false);
  const [roleHistory, setRoleHistory] = useState(null);

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
      setOrdersError(data.error || '');
    } catch (err) {
      setOrdersError(err.message);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const loadSessionHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/session-history');
      const data = await res.json().catch(() => ({}));
      if (res.ok) setSessionHistory(data.history || []);
    } catch {
      // Non-critical — the rest of the dashboard still works without it.
    }
  }, []);

  const loadRecipients = useCallback(async () => {
    try {
      const res = await fetch('/api/recipients');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRecipientsError(data.error || `HTTP ${res.status}`);
        return;
      }
      setRecipients(data.recipients || []);
      setBotUsername(data.botUsername || null);
      setRecipientsError('');
    } catch (err) {
      setRecipientsError(err.message);
    }
  }, []);

  const loadRoleHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/recipients/history');
      const data = await res.json().catch(() => ({}));
      if (res.ok) setRoleHistory(data.history || []);
    } catch {
      // Non-critical — the rest of the dashboard still works without it.
    }
  }, []);

  useEffect(() => {
    if (authed !== true) return;
    loadOrders();
    loadSessionHistory();
    loadRecipients();
    loadRoleHistory();
    const interval = setInterval(() => {
      loadStatus();
      loadOrders();
      loadSessionHistory();
      loadRecipients();
      loadRoleHistory();
    }, REFRESH_MS);
    return () => clearInterval(interval);
  }, [authed, loadStatus, loadOrders, loadSessionHistory, loadRecipients, loadRoleHistory]);

  // Re-pulls every recipient's current name/username straight from Telegram
  // (not just the DB) — guarantees "Refresh" makes names verifiably
  // Telegram-sourced right now, not just whatever was last captured.
  async function handleRefreshRecipients() {
    setRecipientsRefreshing(true);
    try {
      const res = await fetch('/api/recipients/refresh', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRecipientsError(data.error || `HTTP ${res.status}`);
        return;
      }
      setRecipients(data.recipients || []);
      setBotUsername(data.botUsername || null);
      setRecipientsError('');
    } catch (err) {
      setRecipientsError(err.message);
    } finally {
      setRecipientsRefreshing(false);
    }
  }

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

  async function saveSession({ curl, marketplace, setText, setMsg }) {
    setMsg('Saving...');
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curl, marketplace }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(`Error: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    setMsg(`Saved ${data.headerCount} headers.`);
    setText('');
    loadStatus();
    loadOrders();
    loadSessionHistory();
  }

  async function handleCheckNow() {
    setChecking(true);
    const res = await fetch('/api/admin/check-now', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    setChecking(false);
    if (!res.ok) {
      alert(`Check failed — Myntra: ${data.error || 'ok'}, Amazon: ${data.amazonError || 'ok'}`);
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

  // A second password, separate from the dashboard login itself — role
  // changes and removals affect who gets alerted about real orders/returns,
  // so this is a deliberate extra confirmation on top of just being logged
  // in. Checked again server-side regardless (never trust this prompt alone).
  function promptRolePassword() {
    return window.prompt('Enter the role-change password to continue:');
  }

  async function handleSetRole(chatId, role) {
    const rolePassword = promptRolePassword();
    if (rolePassword === null) return; // cancelled
    setRoleBusy(chatId);
    const res = await fetch(`/api/recipients/${chatId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, password: rolePassword }),
    });
    const data = await res.json().catch(() => ({}));
    setRoleBusy(null);
    if (!res.ok) {
      alert(`Could not change role: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    loadRecipients();
    loadRoleHistory();
  }

  async function handleRemoveRecipient(chatId, name) {
    if (!window.confirm(`Remove ${name || chatId} from the recipients list? They'll stop receiving alerts immediately.`)) {
      return;
    }
    const rolePassword = promptRolePassword();
    if (rolePassword === null) return; // cancelled
    setRoleBusy(chatId);
    const res = await fetch(`/api/recipients/${chatId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: rolePassword }),
    });
    const data = await res.json().catch(() => ({}));
    setRoleBusy(null);
    if (!res.ok) {
      alert(`Could not remove: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    loadRecipients();
  }

  if (authed === null) {
    return (
      <main className="auth-page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="auth-page">
        <div className="auth-shell">
          <div className="auth-header">
            <div className="auth-brand">
              <span className="auth-logo">
                <BellIcon />
              </span>
              <h1>Order Alerts</h1>
            </div>
            {theme && (
              <button type="button" className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme">
                {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              </button>
            )}
          </div>
          <form onSubmit={handleLogin} className="auth-card">
            <p className="auth-subtitle">Sign in to view live orders and manage sessions.</p>
            <label htmlFor="password">Password</label>
            <div className="input-with-icon">
              <LockIcon />
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoFocus
              />
            </div>
            <button type="submit" className="auth-submit">
              Log in
            </button>
            {loginError && (
              <p className="auth-error">
                <AlertIcon />
                {loginError}
              </p>
            )}
          </form>
        </div>
      </main>
    );
  }

  const running = Boolean(status?.running);
  const now = Date.now();
  const visibleOrders = (orders || []).filter(
    (o) => (fSource === 'all' || o.source === fSource) && !(o.shipByMs && o.shipByMs < now)
  );

  // Group session-history entries by calendar day (browser-local, i.e. IST for
  // this seller) so the history reads as one section per date.
  const historyGroups = [];
  for (const entry of sessionHistory || []) {
    const dateKey = new Date(entry.capturedAt).toLocaleDateString();
    const last = historyGroups[historyGroups.length - 1];
    if (last && last.dateKey === dateKey) last.entries.push(entry);
    else historyGroups.push({ dateKey, entries: [entry] });
  }

  return (
    <main className="wrap">
      <div className="topbar">
        <h1>Order Alerts</h1>
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
      </div>

      <div className="section-title">
        <h2>Open orders</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <select value={fSource} onChange={(e) => setFSource(e.target.value)} aria-label="Filter by platform">
            <option value="all">All platforms</option>
            <option value="myntra">Myntra</option>
            <option value="amazon">Amazon</option>
          </select>
          <span className="muted">
            {orders ? `${visibleOrders.length} order${visibleOrders.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>
      </div>

      {ordersError && <div className="banner bad">{ordersError}</div>}

      {orders === null && !ordersError && (
        <div className="order-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonOrderCard key={i} />
          ))}
        </div>
      )}

      {orders && visibleOrders.length === 0 && !ordersError && (
        <div className="card empty-state">No open orders right now.</div>
      )}

      {orders && visibleOrders.length > 0 && (
        <div className="order-grid">
          {visibleOrders.map((order) => {
            const isMulti = order.items.length > 1;
            const solo = order.items[0];
            return (
              <div className="order-card" key={`${order.source}-${order.orderId}`}>
                {!isMulti && (solo?.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="order-card-image" src={solo.image} alt={solo.name || 'Product'} />
                ) : (
                  <div className="order-card-image" />
                ))}
                <div className="order-card-body">
                  <div className="order-card-toprow">
                    <span className={`source-tag ${order.source}`}>{order.source === 'amazon' ? 'Amazon' : 'Myntra'}</span>
                    {isMulti && <span className="multi-badge">Multi order</span>}
                  </div>

                  {isMulti ? (
                    <div className="order-item-list">
                      {order.items.map((item, i) => (
                        <div className="order-item-row" key={i}>
                          {item.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className="order-item-thumb" src={item.image} alt={item.name || 'Product'} />
                          ) : (
                            <div className="order-item-thumb" />
                          )}
                          <div className="order-item-info">
                            <div className="order-card-name">{item.name || 'Unnamed product'}</div>
                            <div className="order-card-meta">
                              {item.size ? `Size ${item.size}` : ''}
                              {item.color ? ` · ${item.color}` : ''}
                            </div>
                            {item.sku && <span className="sku-tag">{item.sku}</span>}
                            {item.qty > 1 && <span className="sku-tag qty-tag">×{item.qty}</span>}
                            {item.stock && (
                              <div className={`stock-line ${item.stock.level}`}>
                                {item.stock.level === 'out' ? 'OUT OF STOCK' : `Stock: ${item.stock.label}`}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : solo ? (
                    <>
                      <div className="order-card-name">{solo.name || 'Unnamed product'}</div>
                      <div className="order-card-meta">
                        {solo.size ? `Size ${solo.size}` : ''}
                        {solo.color ? ` · ${solo.color}` : ''}
                      </div>
                      {solo.sku && <span className="sku-tag">{solo.sku}</span>}
                      {solo.qty > 1 && <span className="sku-tag qty-tag">×{solo.qty}</span>}
                      {solo.stock && (
                        <div className={`stock-line ${solo.stock.level}`}>
                          {solo.stock.level === 'out' ? 'OUT OF STOCK' : `Stock: ${solo.stock.label}`}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="order-card-name">Order #{order.orderId}</div>
                      <div className="order-card-meta">Qty {order.quantity ?? '?'}</div>
                    </>
                  )}

                  {order.shipByMs && (
                    <div className="order-card-meta">Ship by {new Date(order.shipByMs).toLocaleDateString()}</div>
                  )}
                  <div className="order-card-footer">
                    <span>#{order.orderId}</span>
                    <span>{order.orderDateMs ? new Date(order.orderDateMs).toLocaleDateString() : ''}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <details className="card">
        <summary>Session history</summary>
        {historyGroups.length === 0 ? (
          <p className="muted">No sessions recorded yet — this starts tracking from your next paste.</p>
        ) : (
          historyGroups.map((g) => (
            <div className="history-day" key={g.dateKey}>
              <div className="history-date">{g.dateKey}</div>
              {g.entries.map((entry) => (
                <div className="history-row" key={entry._id}>
                  <span className={`source-tag ${entry.marketplace}`}>
                    {entry.marketplace === 'amazon' ? 'Amazon' : 'Myntra'}
                  </span>
                  <span>{new Date(entry.capturedAt).toLocaleTimeString()}</span>
                  <span className="muted">→</span>
                  {entry.expiredAt ? (
                    <>
                      <span>{new Date(entry.expiredAt).toLocaleTimeString()}</span>
                      <span className="sku-tag">{formatDuration(entry.durationMs)}</span>
                      {entry.endedBy === 'replaced' && <span className="muted">(replaced)</span>}
                    </>
                  ) : (
                    <span className="history-active">Still active</span>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </details>

      <details className="card" open>
        <summary>Alert recipients</summary>
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
      </details>

      <details className="card">
        <summary>Role change history</summary>
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
      </details>

      <details className="card">
        <summary>Refresh Myntra session</summary>
        <p>
          DevTools → Network → right-click a partnersapi.myntrainfo.com/api/mdirect/orders request →
          Copy → Copy as cURL (or just copy the Headers panel). Paste the whole thing below.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveSession({ curl: curlText, marketplace: 'myntra', setText: setCurlText, setMsg: setSaveMsg });
          }}
        >
          <textarea
            rows={6}
            value={curlText}
            onChange={(e) => setCurlText(e.target.value)}
            placeholder="curl --url 'https://partnersapi.myntrainfo.com/...' -H '...' -b '...' ..."
          />
          <button type="submit">Save Myntra session</button>
        </form>
        {saveMsg && <p>{saveMsg}</p>}
      </details>

      <details className="card">
        <summary>Refresh Amazon session</summary>
        <p>
          On sellercentral.amazon.in → DevTools → Network → right-click a request to
          orders-api/search or orders-api/countOrders → Copy → Copy as cURL (or copy the Headers
          panel). Paste the whole thing below.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveSession({ curl: amazonCurlText, marketplace: 'amazon', setText: setAmazonCurlText, setMsg: setAmazonSaveMsg });
          }}
        >
          <textarea
            rows={6}
            value={amazonCurlText}
            onChange={(e) => setAmazonCurlText(e.target.value)}
            placeholder="curl --url 'https://sellercentral.amazon.in/orders-api/search?...' -H '...' -b '...' ..."
          />
          <button type="submit">Save Amazon session</button>
        </form>
        {amazonSaveMsg && <p>{amazonSaveMsg}</p>}
      </details>
    </main>
  );
}
