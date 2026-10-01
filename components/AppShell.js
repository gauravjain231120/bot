'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useDashboard } from '../lib/DashboardContext';
import { sectionForPath } from '../lib/sections';
import { LoginScreen } from './LoginScreen';
import {
  SunIcon, MoonIcon, BellIcon, PlayIcon, StopIcon, RefreshIcon, MenuIcon, CloseIcon,
  HomeIcon, ScanIcon, BoxIcon, BoxCancelIcon, KeyIcon, UsersIcon, ShieldIcon, ChartIcon, LogoutIcon,
} from './icons';

// No standalone Orders nav entry — the orders grid is shown directly on
// Overview (components/OrdersGrid.js) now, so a separate nav link to /orders
// would just be a redundant way to see the same thing. The /orders route
// itself is left in place (still using the same shared OrdersGrid), just not
// linked from here.
// Each link shows only to accounts that may open its section (lib/sections.js
// — Owners everything; a Viewer what the Owner ticked on the Team page).
const NAV_ITEMS = [
  { href: '/', label: 'Overview', Icon: HomeIcon },
  { href: '/returns', label: 'Myntra Return', Icon: ScanIcon },
  { href: '/packed', label: 'Myntra Pack', Icon: BoxIcon },
  { href: '/myntra-cancel', label: 'Myntra Cancel', Icon: BoxCancelIcon },
  { href: '/amazon-packed', label: 'Amazon Pack', Icon: BoxIcon },
  { href: '/amazon-returns', label: 'Amazon Return', Icon: ScanIcon },
  { href: '/sessions', label: 'Sessions', Icon: KeyIcon },
  { href: '/recipients', label: 'Recipients', Icon: UsersIcon },
  { href: '/team', label: 'Team', Icon: ShieldIcon },
  { href: '/spf-status', label: 'SPF Status', Icon: ChartIcon },
  { href: '/engine', label: 'Engine', Icon: ChartIcon },
  { href: '/handover-logs', label: 'Handovers', Icon: ChartIcon },
].map((item) => ({ ...item, section: sectionForPath(item.href) }));

// A page this account may not open: nothing of it is rendered (its data
// wouldn't load anyway — the server refuses it).
function NoAccess({ username }) {
  return (
    <div className="card empty-state">
      <p style={{ fontWeight: 600, marginBottom: 6 }}>You don&apos;t have access to this page.</p>
      <p className="muted">
        {username ? `Signed in as ${username}. ` : ''}Ask the Owner to give it to you on the Team page.
      </p>
    </div>
  );
}

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
    authed, account, can, loadError, theme, toggleTheme,
    running, toggling, checking, testingServer, handleToggle, handleCheckNow, handleTestServer, handleLogout,
  } = useDashboard();
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  // Same 900px breakpoint as the CSS. Tracked in JS too — not just relying
  // on a CSS media query to hide the hamburger/close buttons on desktop —
  // so the mobile-only toggle controls straight up don't exist in the DOM
  // above 900px, no matter what. Real bug this fixes: both were showing at
  // once on a wide screen (stale-cache-proof now, since the JS branch can't
  // silently keep serving an old CSS bundle's behavior).
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Never let a stale "open" drawer state survive resizing past desktop
  // width (e.g. a phone rotated to landscape, or a browser window dragged
  // wider) — the scrim would otherwise stay stuck covering the desktop
  // layout with no way to dismiss it.
  useEffect(() => {
    if (!isMobile) setNavOpen(false);
  }, [isMobile]);

  // What this page needs, and whether this account has it. Landing on a page
  // it can't open (usually "/" — Overview — right after logging in) goes to
  // the first page it can.
  const pageSection = sectionForPath(pathname);
  const pageAllowed = !pageSection || can(pageSection);
  const firstAllowedHref = (NAV_ITEMS.find((item) => can(item.section)) || {}).href || null;
  const accountKnown = !!account;
  useEffect(() => {
    if (authed && accountKnown && !pageAllowed && firstAllowedHref && firstAllowedHref !== pathname) router.replace(firstAllowedHref);
  }, [authed, accountKnown, pageAllowed, firstAllowedHref, pathname, router]);

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

  const visibleNav = NAV_ITEMS.filter((item) => can(item.section));
  const canControl = can('controls');

  return (
    <div className="shell">
      {isMobile && navOpen && <div className="shell-scrim" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar ${isMobile && navOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <span className="auth-logo">
            <BellIcon />
          </span>
          <span className="sidebar-brand-text">Order Alerts</span>
          {isMobile && (
            <button type="button" className="icon-btn sidebar-close" onClick={() => setNavOpen(false)} aria-label="Close menu">
              <CloseIcon />
            </button>
          )}
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
          {isMobile && !navOpen && (
            <button type="button" className="icon-btn nav-toggle" onClick={() => setNavOpen(true)} aria-label="Open menu">
              <MenuIcon />
            </button>
          )}
          <div className="topbar-controls">
            {canControl && (
              <>
                <button className={running ? 'danger' : ''} onClick={handleToggle} disabled={toggling}>
                  {running ? <StopIcon /> : <PlayIcon />}
                  {toggling ? 'Working...' : running ? 'Stop' : 'Start'}
                </button>
                <button className="secondary" onClick={handleCheckNow} disabled={checking}>
                  <RefreshIcon spinning={checking} />
                  {checking ? 'Checking...' : 'Check now'}
                </button>
                {account.role === 'OWNER' && (
                  <button className="secondary" onClick={handleTestServer} disabled={testingServer}>
                    {testingServer ? 'Testing...' : 'Test Server'}
                  </button>
                )}
              </>
            )}
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
        <main className="shell-content">
          {!account ? <p className="muted">{loadError || 'Loading…'}</p> : pageAllowed ? children : <NoAccess username={account.username} />}
        </main>
      </div>
    </div>
  );
}
