import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { formatZAR, type Cents } from '@/domain/money';
import { formatDisplayDate, type IsoDate } from '@/domain/dates';
import { WORKSPACE_LABELS, type WorkspaceView } from '@/domain/models';

export function Money({
  cents,
  signed = false,
  tone = false,
  className = '',
}: {
  cents: Cents;
  /** Show a leading + for positive amounts. */
  signed?: boolean;
  /** Colour positive/negative amounts (always paired with the sign, never colour alone). */
  tone?: boolean;
  className?: string;
}) {
  const toneClass = tone ? (cents < 0 ? 'negative' : cents > 0 ? 'positive' : '') : '';
  const text = formatZAR(cents);
  return (
    <span className={`num ${toneClass} ${className}`.trim()}>
      {signed && cents > 0 ? '+' : ''}
      {text}
    </span>
  );
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

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Loading() {
  return (
    <p className="muted" role="status">
      Loading your data…
    </p>
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
