import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: '◎' },
  { to: '/transactions', label: 'Transactions', icon: '≡' },
  { to: '/import', label: 'Import statement', icon: '⇩' },
  { to: '/budgets', label: 'Budgets', icon: '▤' },
  { to: '/goals', label: 'Goals', icon: '◆' },
  { to: '/accounts', label: 'Accounts', icon: '▣' },
  { to: '/business', label: 'Business', icon: '◧' },
  { to: '/reports', label: 'Reports', icon: '▥' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

/** Shown directly in the mobile bottom bar; the rest live under "More". */
const MOBILE_PRIMARY = ['/', '/transactions', '/budgets', '/goals'];

export function Layout() {
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMoreOpen(false), [location.pathname]);

  const secondary = NAV.filter((n) => !MOBILE_PRIMARY.includes(n.to));
  const moreActive = secondary.some((n) => n.to === location.pathname);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">Personal Finance Hub</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}>
            <span className="nav-icon" aria-hidden="true">
              {n.icon}
            </span>
            {n.label}
          </NavLink>
        ))}
        <div className="sidebar-footer">
          Data is stored on this device only. Back up regularly from Settings.
        </div>
      </nav>

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>

      {moreOpen && (
        <nav className="more-menu" aria-label="More pages">
          {secondary.map((n) => (
            <NavLink key={n.to} to={n.to}>
              {n.label}
            </NavLink>
          ))}
        </nav>
      )}
      <nav className="bottom-nav" aria-label="Main">
        {NAV.filter((n) => MOBILE_PRIMARY.includes(n.to)).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}>
            <span className="nav-icon" aria-hidden="true">
              {n.icon}
            </span>
            {n.label}
          </NavLink>
        ))}
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-current={moreActive ? 'page' : undefined}
          onClick={() => setMoreOpen((o) => !o)}
        >
          <span className="nav-icon" aria-hidden="true">
            ⋯
          </span>
          More
        </button>
      </nav>
    </div>
  );
}
