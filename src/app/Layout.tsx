import { useSync } from './SyncContext';
import { SyncPill } from '@/features/settings/SyncCard';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { Icon, type IconName } from '@/components/icons';
import { MORE_PATHS, NAV_GROUPS, TAB_ITEMS } from './nav';

const ADD_ACTIONS: { to: string; label: string; hint: string; icon: IconName }[] = [
  {
    to: '/import',
    label: 'Import bank statement',
    hint: 'A CSV file from your banking app or website',
    icon: 'import',
  },
  {
    to: '/transactions?new=1',
    label: 'Add a transaction',
    hint: 'Cash, a card payment or income',
    icon: 'plus',
  },
  {
    to: '/transactions?new=transfer',
    label: 'Move money',
    hint: 'A transfer between your own accounts',
    icon: 'transfer',
  },
];

/** Bottom sheet opened by the tab bar's Add button. */
function AddSheet({ onClose }: { onClose: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    sheetRef.current?.querySelector<HTMLElement>('a')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-layer">
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-sheet-title"
      >
        <div className="sheet-grab" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id="add-sheet-title">Add</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <ul className="action-list">
          {ADD_ACTIONS.map((a) => (
            <li key={a.to}>
              <Link to={a.to} className="action-row">
                <span className="action-icon">
                  <Icon name={a.icon} />
                </span>
                <span className="action-text">
                  <strong>{a.label}</strong>
                  <small>{a.hint}</small>
                </span>
                <Icon name="chevron-right" size={18} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Layout() {
  const [addOpen, setAddOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const sync = useSync();
  const location = useLocation();
  useEffect(() => {
    setAddOpen(false);
  }, [location.pathname, location.search]);
  // Each page starts at the top, like a native app (jsdom has no scrollTo).
  useEffect(() => {
    if (typeof window.scrollTo === 'function' && !navigator.userAgent.includes('jsdom')) {
      window.scrollTo(0, 0);
    }
  }, [location.pathname]);

  const moreActive = MORE_PATHS.includes(location.pathname);
  const closeAdd = () => {
    setAddOpen(false);
    addButton.current?.focus();
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Finance Hub
        </div>
        {NAV_GROUPS.map((g) => (
          <div key={g.label ?? 'main'} className="sidebar-group">
            {g.label && <div className="sidebar-group-label">{g.label}</div>}
            {g.items.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'}>
                <Icon name={n.icon} size={20} />
                {n.label}
              </NavLink>
            ))}
          </div>
        ))}
        <div className="sidebar-footer">
          {sync ? (
            <NavLink to="/settings" className="sync-pill-link">
              <SyncPill />
            </NavLink>
          ) : (
            'Data is stored on this device only. Back up regularly from Settings.'
          )}
        </div>
      </nav>

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>

      {addOpen && <AddSheet onClose={closeAdd} />}
      <nav className="tab-bar" aria-label="Main">
        {TAB_ITEMS.slice(0, 2).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className="tab">
            <Icon name={n.icon} />
            {n.label}
          </NavLink>
        ))}
        <button
          ref={addButton}
          type="button"
          className="tab tab-add"
          aria-haspopup="dialog"
          aria-expanded={addOpen}
          onClick={() => setAddOpen((o) => !o)}
        >
          <span className="tab-add-button">
            <Icon name="plus" size={26} />
          </span>
          Add
        </button>
        {TAB_ITEMS.slice(2).map((n) => (
          <NavLink key={n.to} to={n.to} className="tab">
            <Icon name={n.icon} />
            {n.label}
          </NavLink>
        ))}
        <Link to="/more" className="tab" aria-current={moreActive ? 'page' : undefined}>
          <Icon name="more" />
          More
        </Link>
      </nav>
    </div>
  );
}
