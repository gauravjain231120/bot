'use client';

import { useState } from 'react';
import { useDashboard } from '../lib/DashboardContext';
import { BellIcon, LockIcon, AlertIcon, SunIcon, MoonIcon } from './icons';

export function LoginScreen() {
  const { theme, toggleTheme, handleLogin } = useDashboard();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setLoginError('');
    setSubmitting(true);
    try {
      await handleLogin(username, password);
      setPassword('');
    } catch (err) {
      setLoginError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

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
        <form onSubmit={onSubmit} className="auth-card">
          <p className="auth-subtitle">Sign in to view live orders and manage sessions.</p>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your username"
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
          />
          <label htmlFor="password" style={{ marginTop: 10 }}>Password</label>
          <div className="input-with-icon">
            <LockIcon />
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
            />
          </div>
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Log in'}
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
