'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDashboard } from '../lib/DashboardContext';
import { LoginScreen } from './LoginScreen';
import {
  SunIcon, MoonIcon, BellIcon, PlayIcon, StopIcon, RefreshIcon, MenuIcon, CloseIcon,
  HomeIcon, BoxIcon, ScanIcon, KeyIcon, UsersIcon, ShieldIcon, ChartIcon, LogoutIcon,
} from './icons';

const NAV_ITEMS = [
  { href: '/', label: 'Overview', Icon: HomeIcon },
  { href: '/orders', label: 'Orders', Icon: BoxIcon },
  { href: '/returns', label: 'Scan Return', Icon: ScanIcon },
  { href: '/sessions', label: 'Sessions', Icon: KeyIcon },
  { href: '/recipients', label: 'Recipients', Icon: UsersIcon, ownerOnly: true },
  { href: '/team', label: 'Team', Icon: ShieldIcon, ownerOnly: true },
  { href: '/spf-status', label: 'SPF Status', Icon: ChartIcon, ownerOnly: true },
];

/**
 * The app shell every page renders inside (wired in app/layout.js) — sidebar
 * nav + persistent topbar (Live/Stop/Check now/account/theme/logout), same
 * controls the old single-page dashboard's topbar had, just now shared
 * across real page navigation instead of re-declared per page. Falls back to
 * the login screen (no sidebar) while not authed — identical branching to
 * the old page.js's authed===null / !authed checks.
 */
export function AppShell({ children }) {
  const {
    authed, account, isOwner, theme, toggleTheme,
    running, toggling, checking, handleToggle, handleCheckNow, handleLogout,
  } = useDashboard();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  if (authed === null) {
    return (
      <main className="auth-page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (!authed) {
    return <LoginScreen />;
  }

  const visibleNav = NAV_ITEMS.filter((item) => !item.ownerOnly || isOwner);

  return (
    <div className="shell">
      {navOpen && <div className="shell-scrim" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <span className="auth-logo">
            <BellIcon />
          </span>
          <span className="sidebar-brand-text">Order Alerts</span>
          <button type="button" className="icon-btn sidebar-close" onClick={() => setNavOpen(false)} aria-label="Close menu">
            <CloseIcon />
          </button>
        </div>
        <nav className="sidebar-nav">
          {visibleNav.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              className={`sidebar-link ${pathname === href ? 'active' : ''}`}
              onClick={() => setNavOpen(false)}
            >
              <Icon />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`pill ${running ? 'live' : 'stopped'}`}>
            <span className="pill-dot" />
            {running ? 'Live' : 'Stopped'}
          </span>
        </div>
      </aside>

      <div className="shell-main">
        <div className="topbar">
          <button type="button" className="icon-btn nav-toggle" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <MenuIcon />
          </button>
          <div className="topbar-controls">
            <button className={running ? 'danger' : ''} onClick={handleToggle} disabled={toggling}>
              {running ? <StopIcon /> : <PlayIcon />}
              {toggling ? 'Working...' : running ? 'Stop' : 'Start'}
            </button>
            <button className="secondary" onClick={handleCheckNow} disabled={checking}>
              <RefreshIcon spinning={checking} />
              {checking ? 'Checking...' : 'Check now'}
            </button>
          </div>
          <div className="topbar-controls">
            {account && (
              <span className="muted account-chip">
                {account.username} · {account.role === 'OWNER' ? 'Owner' : 'Viewer'}
              </span>
            )}
            <button type="button" className="secondary" onClick={handleLogout} title="Log out" aria-label="Log out">
              <LogoutIcon />
            </button>
            {theme && (
              <button type="button" className="icon-btn" onClick={toggleTheme} aria-label="Toggle theme">
                {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              </button>
            )}
          </div>
        </div>
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
