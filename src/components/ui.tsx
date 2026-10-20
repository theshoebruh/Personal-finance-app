import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { formatZAR, formatZARWhole, type Cents } from '@/domain/money';
import { Icon, type IconName } from './icons';
import { formatDisplayDate, type IsoDate } from '@/domain/dates';
import { WORKSPACE_LABELS, type WorkspaceView } from '@/domain/models';

export function Money({
  cents,
  signed = false,
  tone = false,
  whole = false,
  split = false,
  className = '',
}: {
  cents: Cents;
  /** Show a leading + for positive amounts. */
  signed?: boolean;
  /** Colour positive/negative amounts (always paired with the sign, never colour alone). */
  tone?: boolean;
  /** Round to whole rand (compact labels; the exact figure must be shown elsewhere). */
  whole?: boolean;
  /** Set the cents smaller than the rand, for headline figures. */
  split?: boolean;
  className?: string;
}) {
  const toneClass = tone ? (cents < 0 ? 'negative' : cents > 0 ? 'positive' : '') : '';
  const text = whole ? formatZARWhole(cents) : formatZAR(cents);
  const sign = signed && cents > 0 ? '+' : '';
  const comma = split && !whole ? text.lastIndexOf(',') : -1;
  return (
    <span className={`num ${toneClass} ${className}`.trim()}>
      {sign}
      {comma > 0 ? (
        <>
          {text.slice(0, comma)}
          <span className="num-cents">{text.slice(comma)}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
}

/** Figures that have already counted up this session (they only do it the first time). */
const counted = new Set<string>();

function shouldCountUp(key: string): boolean {
  return (
    !counted.has(key) &&
    typeof window.matchMedia === 'function' &&
    typeof window.requestAnimationFrame === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * A headline amount that counts up from zero the first time it's shown (about 0.7s), then
 * stays put. Display only: it ends on exactly `cents`, and shows `cents` straight away under
 * reduced motion or where animation frames aren't available.
 */
export function CountUpMoney({
  countKey,
  cents,
  ...rest
}: { countKey: string } & Parameters<typeof Money>[0]) {
  const [shown, setShown] = useState(() => (shouldCountUp(countKey) ? 0 : cents));
  useEffect(() => {
    if (!shouldCountUp(countKey)) {
      setShown(cents);
      return;
    }
    const duration = 700;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      setShown(Math.round(cents * (1 - (1 - p) ** 3)) || 0); // || 0: never show "-0"
      if (p < 1) frame = window.requestAnimationFrame(tick);
      else counted.add(countKey);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [cents, countKey]);
  return <Money cents={shown} {...rest} />;
}

export function DateText({ date }: { date: IsoDate }) {
  return <time dateTime={date}>{formatDisplayDate(date)}</time>;
}

export function Card({
  title,
  action,
  children,
  className = '',
  labelledBy,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  const id = useId();
  const headingId = labelledBy ?? id;
  return (
    <section className={`card ${className}`.trim()} aria-labelledby={title ? headingId : undefined}>
      {(title || action) && (
        <div className="card-header">
          {title && <h2 id={headingId}>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export type AlertTone = 'info' | 'warning' | 'negative' | 'success';
const ALERT_ICONS: Record<AlertTone, string> = {
  info: 'i',
  warning: '!',
  negative: '!',
  success: '✓',
};

export function Alert({
  tone = 'info',
  children,
  action,
}: {
  tone?: AlertTone;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'negative' ? 'alert' : undefined}>
      <span className="alert-icon" aria-hidden="true">
        {ALERT_ICONS[tone]}
      </span>
      <div className="stack">
        <div>{children}</div>
        {action}
      </div>
    </div>
  );
}

export function Badge({
  kind = 'default',
  children,
}: {
  kind?: 'default' | 'forecast' | 'actual' | 'warning' | 'negative' | 'demo';
  children: ReactNode;
}) {
  return <span className={kind === 'default' ? 'badge' : `badge badge-${kind}`}>{children}</span>;
}

export function Empty({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: IconName;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && (
        <span className="empty-icon">
          <Icon name={icon} size={26} />
        </span>
      )}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** Placeholder shapes in the layout's place while data loads; the words are for screen readers. */
export function Loading() {
  return (
    <div className="skeleton-page" role="status">
      <span className="visually-hidden">Loading your data…</span>
      <span className="skeleton skeleton-title" aria-hidden="true" />
      <span className="skeleton skeleton-line" aria-hidden="true" />
      <span className="skeleton skeleton-hero" aria-hidden="true" />
      <span className="skeleton skeleton-card" aria-hidden="true" />
      <span className="skeleton skeleton-card" aria-hidden="true" />
    </div>
  );
}

export function WorkspaceSwitcher({
  value,
  onChange,
}: {
  value: WorkspaceView;
  onChange: (v: WorkspaceView) => void;
}) {
  const views: WorkspaceView[] = ['personal', 'business', 'combined'];
  return (
    <div className="segmented" role="group" aria-label="Workspace">
      {views.map((v) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {WORKSPACE_LABELS[v]}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && (
        <span className="hint" id={`${htmlFor}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="error" id={`${htmlFor}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Status messages announced to screen readers and shown briefly as a toast. */
export function useStatus() {
  const [status, setStatus] = useState<{ tone: AlertTone; text: string } | null>(null);
  useEffect(() => {
    if (!status) return;
    const t = window.setTimeout(() => setStatus(null), status.tone === 'negative' ? 8000 : 4000);
    return () => window.clearTimeout(t);
  }, [status]);
  const run = useCallback(async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) setStatus({ tone: 'success', text: success });
      return true;
    } catch (e) {
      setStatus({ tone: 'negative', text: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, []);
  const node = (
    <div className="status-toast" aria-live="polite">
      {status && <Alert tone={status.tone}>{status.text}</Alert>}
    </div>
  );
  return { run, setStatus, statusNode: node };
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const safeMax = Math.max(1, max);
  return (
    <progress value={Math.min(Math.max(0, value), safeMax)} max={safeMax} aria-label={label} />
  );
}

/** Read a picked file as UTF-8 text (FileReader works in older Safari and in tests). */
export function readFileText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsText(file, 'utf-8');
  });
}
