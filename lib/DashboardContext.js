'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

// 6-ish API calls fire every tick (status/orders/otcConfig/otcStatus,
// +recipients/roleHistory for an Owner) while the dashboard is open — at 20s
// that's thousands of invocations/day if left open for hours, a meaningful
// chunk of Vercel Hobby's Active CPU allowance. 60s still feels live but
// cuts that load to a third.
const REFRESH_MS = 60000;

const DashboardCtx = createContext(null);

/**
 * Everything genuinely cross-page: auth, theme, and every piece of state the
 * single 60s poll loop keeps fresh regardless of which page is currently
 * shown — moved verbatim out of the old single-page app/page.js so real
 * page navigation doesn't lose live data or duplicate the poll loop.
 *
 * Deliberately NOT in the interval (fetch once, on the relevant action,
 * only): loadPackedCount and loadAccounts — both hit either a live Myntra
 * API or are Owner-only management data with no need to be "live". This
 * exclusion is load-bearing (tuned earlier for Active CPU cost) — do not
 * add them to the interval.
 */
export function DashboardProvider({ children }) {
  const [authed, setAuthed] = useState(null); // null = loading
  const [account, setAccount] = useState(null); // {username, role} once logged in
  const isOwner = account?.role === 'OWNER';

  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [orders, setOrders] = useState(null);
  const [ordersError, setOrdersError] = useState('');
  const [checking, setChecking] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [theme, setTheme] = useState(null);

  const [recipients, setRecipients] = useState(null);
  const [recipientsError, setRecipientsError] = useState('');
  const [botUsername, setBotUsername] = useState(null);
  const [roleBusy, setRoleBusy] = useState(null); // chatId currently being updated, or null
  const [recipientsRefreshing, setRecipientsRefreshing] = useState(false);
  const [roleHistory, setRoleHistory] = useState(null);

  const [otcScope, setOtcScope] = useState(null);
  const [otcScopeBusy, setOtcScopeBusy] = useState(false);
  const [otcStatus, setOtcStatus] = useState(null);
  const [otcClearing, setOtcClearing] = useState(false);

  const [packedCount, setPackedCount] = useState(null);
  const [packedCountError, setPackedCountError] = useState('');
  const [packedLoading, setPackedLoading] = useState(false);

  const [accounts, setAccounts] = useState(null);
  const [accountsError, setAccountsError] = useState('');

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
      setAccount(data.account || null);
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

  // Owner only — a Viewer's request would just 403, so there's nothing to
  // show them anyway. Loaded once account is known to avoid that pointless
  // round trip on every Viewer's dashboard load.
  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/accounts');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAccountsError(data.error || `HTTP ${res.status}`);
        return;
      }
      setAccounts(data.accounts || []);
      setAccountsError('');
    } catch (err) {
      setAccountsError(err.message);
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

  const loadOtcConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/otc-config');
      const data = await res.json().catch(() => ({}));
      if (res.ok) setOtcScope(data.recipientScope || 'OWNER');
    } catch {
      // Non-critical — the rest of the dashboard still works without it.
    }
  }, []);

  const loadOtcStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/otc-status');
      const data = await res.json().catch(() => ({}));
      if (res.ok) setOtcStatus(data);
    } catch {
      // Non-critical — the rest of the dashboard still works without it.
    }
  }, []);

  // Deliberately NOT in the 60s auto-refresh loop below — unlike the other
  // dashboard stats, this hits Myntra's live API on every call (the others
  // just read already-stored DB state). Only fires once, when this page is
  // actually opened — leaving the tab open must never cause a recurring
  // background Myntra call purely because the interval ticked.
  // fresh: the card's Refresh button — skips the server's 10-min cache.
  const loadPackedCount = useCallback(async (fresh = false) => {
    setPackedLoading(true);
    try {
      const res = await fetch(fresh === true ? '/api/packed-count?fresh=1' : '/api/packed-count');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPackedCountError(data.error || `HTTP ${res.status}`);
        return;
      }
      setPackedCount(data);
      setPackedCountError('');
    } catch (err) {
      setPackedCountError(err.message);
    } finally {
      setPackedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authed !== true) return;
    loadOrders();
    loadOtcConfig();
    loadOtcStatus();
    loadPackedCount();
    if (isOwner) {
      loadRecipients();
      loadRoleHistory();
      loadAccounts();
    }
    // Paused while the tab is hidden (nobody's looking) — refreshed right
    // away when it's shown again. None of these call Myntra/Amazon anymore
    // (the order grid reads the checks' saved snapshot), this just avoids
    // needless server hits from background tabs.
    // loadOtcConfig() isn't polled: that setting only changes when someone
    // changes it here (which reloads it) — loaded once above.
    const tick = () => {
      loadStatus();
      loadOrders();
      loadOtcStatus();
      if (isOwner) {
        loadRecipients();
        loadRoleHistory();
      }
      // loadPackedCount() / loadAccounts() intentionally excluded — see their own comments above.
    };
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      tick();
    }, REFRESH_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // isOwner (not the whole `account` object) on purpose — `account` is a
    // new object reference on every /api/status response, which would
    // re-trigger this whole effect (and its immediate extra loads) on every
    // single poll; the primitive role value only actually changes when the
    // role itself does.
  }, [authed, isOwner, loadStatus, loadOrders, loadRecipients, loadRoleHistory, loadOtcConfig, loadOtcStatus, loadPackedCount, loadAccounts]);

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

  async function handleLogin(username, password) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Wrong username or password');
    }
    loadStatus();
  }

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    setAuthed(false);
    setAccount(null);
  }

  async function saveSession({ curl, marketplace }) {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curl, marketplace }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    loadStatus();
    loadOrders();
    return data;
  }

  // try/finally: a dropped connection must never leave the button stuck on
  // "Checking..." / "Working..." until the page is reloaded.
  async function handleCheckNow() {
    setChecking(true);
    try {
      const res = await fetch('/api/admin/check-now', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Check failed — Myntra: ${data.error || 'ok'}, Amazon: ${data.amazonError || 'ok'}`);
        return;
      }
      loadStatus();
      loadOrders();
    } catch (err) {
      alert(`Could not reach the server: ${err.message}`);
    } finally {
      setChecking(false);
    }
  }

  async function handleToggle() {
    setToggling(true);
    try {
      const endpoint = status?.running ? '/api/admin/stop' : '/api/admin/start';
      const res = await fetch(endpoint, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Could not toggle: ${data.error || `HTTP ${res.status}`}`);
        return;
      }
      loadStatus();
      loadOrders();
    } catch (err) {
      alert(`Could not reach the server: ${err.message}`);
    } finally {
      setToggling(false);
    }
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
    let res;
    try {
      res = await fetch(`/api/recipients/${encodeURIComponent(chatId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, password: rolePassword }),
      });
    } catch (err) {
      setRoleBusy(null);
      alert(`Could not reach the server: ${err.message}`);
      return;
    }
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
    let res;
    try {
      res = await fetch(`/api/recipients/${encodeURIComponent(chatId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: rolePassword }),
      });
    } catch (err) {
      setRoleBusy(null);
      alert(`Could not reach the server: ${err.message}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setRoleBusy(null);
    if (!res.ok) {
      alert(`Could not remove: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    loadRecipients();
  }

  async function handleSetOtcScope(scope) {
    setOtcScopeBusy(true);
    let res;
    try {
      res = await fetch('/api/otc-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientScope: scope }),
      });
    } catch (err) {
      setOtcScopeBusy(false);
      alert(`Could not reach the server: ${err.message}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setOtcScopeBusy(false);
    if (!res.ok) {
      alert(`Could not change this: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    setOtcScope(scope);
  }

  // Display-only — hides today's code from this card, never touches
  // alertedDate, so it can never make the poller call Myntra again today.
  // Owner-only: the daily OTC check window, "HH:MM" India time. Returns
  // { ok } or { ok: false, error } so the editor can show the reason inline.
  async function handleSetOtcWindow(start, end) {
    try {
      const res = await fetch('/api/otc-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ window: { start, end } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
      await loadOtcStatus();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function handleClearOtc() {
    setOtcClearing(true);
    let res;
    try {
      res = await fetch('/api/otc-status', { method: 'PATCH' });
    } catch (err) {
      setOtcClearing(false);
      alert(`Could not reach the server: ${err.message}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setOtcClearing(false);
    if (!res.ok) {
      alert(`Could not clear: ${data.error || `HTTP ${res.status}`}`);
      return;
    }
    setOtcStatus(data);
  }

  // Same confirmation prompt as promptRolePassword() above, worded for the
  // dashboard-accounts context specifically (still the same
  // ROLE_CHANGE_PASSWORD server-side) — adding, re-roling, or removing a
  // dashboard login is exactly the same class of "who has access" change as
  // a Telegram recipient's role, so it gets the same extra confirmation.
  function promptAccountPassword() {
    return window.prompt('Enter the confirmation password to continue:');
  }

  async function handleAddAccount({ username, password, role }) {
    const confirmPassword = promptAccountPassword();
    if (confirmPassword === null) return; // cancelled
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role, confirmPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    loadAccounts();
  }

  async function handleChangeAccountRole(username, role) {
    const confirmPassword = promptAccountPassword();
    if (confirmPassword === null) return; // cancelled
    const res = await fetch(`/api/accounts/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, confirmPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAccountsError(data.error || `HTTP ${res.status}`);
      return;
    }
    loadAccounts();
  }

  async function handleDeleteAccount(name) {
    if (!window.confirm(`Remove "${name}" from the Team? They'll be logged out immediately.`)) return;
    const confirmPassword = promptAccountPassword();
    if (confirmPassword === null) return; // cancelled
    const res = await fetch(`/api/accounts/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setAccountsError(data.error || `HTTP ${res.status}`);
      return;
    }
    loadAccounts();
  }

  const value = {
    authed, account, isOwner,
    theme, toggleTheme,
    status, loadError, running: Boolean(status?.running), checking, toggling,
    handleCheckNow, handleToggle, handleLogin, handleLogout,
    orders, ordersError, loadOrders,
    saveSession,
    recipients, recipientsError, botUsername, roleBusy, recipientsRefreshing,
    handleRefreshRecipients, handleSetRole, handleRemoveRecipient,
    roleHistory,
    otcScope, otcScopeBusy, handleSetOtcScope,
    otcStatus, otcClearing, handleClearOtc, handleSetOtcWindow,
    packedCount, packedCountError, packedLoading, loadPackedCount,
    accounts, accountsError, handleAddAccount, handleDeleteAccount, handleChangeAccountRole,
  };

  return <DashboardCtx.Provider value={value}>{children}</DashboardCtx.Provider>;
}

export function useDashboard() {
  const ctx = useContext(DashboardCtx);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}
