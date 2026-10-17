import { Link } from 'react-router';
import { useSync } from '@/app/SyncContext';
import { MORE_GROUPS } from '@/app/nav';
import { Icon } from '@/components/icons';
import { PageHeader } from '@/components/PageHeader';
import { SyncPill } from '@/features/settings/SyncCard';

/** The phone's More tab: every page that doesn't have its own tab. */
export function MorePage() {
  const sync = useSync();
  return (
    <>
      <PageHeader title="More" />
      <div className="grid">
        {MORE_GROUPS.map((group, i) => (
          <ul key={i} className="nav-list">
            {group.map((n) => (
              <li key={n.to}>
                <Link to={n.to}>
                  <span className="nav-list-icon">
                    <Icon name={n.icon} size={20} />
                  </span>
                  <span className="nav-list-text">
                    <strong>{n.label}</strong>
                    {n.hint && <small>{n.hint}</small>}
                  </span>
                  <Icon name="chevron-right" size={18} />
                </Link>
              </li>
            ))}
          </ul>
        ))}
        <p className="small faint more-footer">
          {sync ? (
            <Link to="/settings" className="sync-pill-link">
              <SyncPill />
            </Link>
          ) : (
            'Your data is stored on this device only. Back up regularly from Settings.'
          )}
        </p>
      </div>
    </>
  );
}
