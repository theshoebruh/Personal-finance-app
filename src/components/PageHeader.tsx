import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { BACK_LINKS } from '@/app/nav';
import { Icon } from './icons';

/**
 * The top of every page: a sticky bar with the back link (phones) and a compact title that
 * appears once the large title scrolls away, then the large title, an optional subtitle and
 * page actions. Gives every screen a clear "where am I" and a way back.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Overrides the default back link for this route; `null` hides it. */
  back?:
    | { to: string; label: string; onLinkClick?: (e: MouseEvent<HTMLAnchorElement>) => void }
    | { onClick: () => void; label: string }
    | null;
}) {
  const { pathname } = useLocation();
  const backLink: typeof back = back === undefined ? BACK_LINKS[pathname] : back;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = titleRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setCompact(!e?.isIntersecting), {
      rootMargin: '-56px 0px 0px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <header className="page-header">
      <div className="page-bar" data-compact={compact}>
        <div className="page-bar-side">
          {backLink &&
            ('to' in backLink ? (
              <Link className="back-link" to={backLink.to} onClick={backLink.onLinkClick}>
                <Icon name="chevron-left" size={20} />
                {backLink.label}
              </Link>
            ) : (
              <button type="button" className="back-link" onClick={backLink.onClick}>
                <Icon name="chevron-left" size={20} />
                {backLink.label}
              </button>
            ))}
        </div>
        <span className="page-bar-title" aria-hidden="true">
          {title}
        </span>
        <div className="page-bar-side" />
      </div>
      <div className="page-title-row">
        <div className="page-title-text">
          <h1 ref={titleRef}>{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </header>
  );
}
