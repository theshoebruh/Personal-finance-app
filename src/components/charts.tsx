/**
 * Small hand-drawn SVG charts (no chart library: the CSP allows no external scripts and the
 * bundle stays lean). Components only draw what they are given: every figure comes from the
 * domain calculations, and the only arithmetic here is geometry (how long an arc or bar is).
 *
 * Accessibility: every chart has an aria label, a written legend (colour is never the only
 * signal) and a table alternative.
 */
import { useId, useState, type ReactNode } from 'react';
import { formatZAR, type Cents } from '@/domain/money';
import { Money } from './ui';

/** Fixed colour slots for categories (see --chart-N in tokens.css); slot 0 is "Other". */
export type ChartColour = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type RingTone = 'positive' | 'negative' | 'warning' | 'accent' | `chart-${ChartColour}`;

/** Fraction of `whole` that `part` is, clamped to 0–1, for drawing. */
export function fraction(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.min(1, Math.max(0, part / whole));
}

/** Whole-number percentage for labels next to a chart (display rounding only). */
export function percentLabel(part: number, whole: number): string {
  return `${Math.round(fraction(part, whole) * 100)}%`;
}

/* ------------------------------------------------------------------ Ring */

export function Ring({
  value,
  label,
  size = 120,
  thickness = 12,
  tone = 'positive',
  children,
}: {
  /** 0–1, how much of the ring is filled. */
  value: number;
  /** Spoken description, e.g. "48% of this period's budget left". */
  label: string;
  size?: number;
  thickness?: number;
  tone?: RingTone;
  /** Shown in the middle of the ring. */
  children?: ReactNode;
}) {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const filled = Math.min(1, Math.max(0, value)) * 100;
  return (
    <div className="ring" role="img" aria-label={label} data-size={size}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring-track" cx={c} cy={c} r={r} fill="none" strokeWidth={thickness} />
        {filled > 0 && (
          <circle
            className={`ring-value tone-${tone}`}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            strokeWidth={thickness}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${filled} 100`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        )}
      </svg>
      {children && (
        <div className="ring-center" aria-hidden="true">
          {children}
        </div>
      )}
    </div>
  );
}

/** A small ring with a caption, used in rows of three on Home. */
export function StatRing({
  value,
  label,
  centre,
  caption,
  detail,
  tone,
}: {
  value: number;
  label: string;
  centre: ReactNode;
  caption: string;
  detail?: ReactNode;
  tone?: RingTone;
}) {
  return (
    <div className="stat-ring">
      <Ring value={value} label={label} size={72} thickness={8} tone={tone}>
        <span className="stat-ring-centre">{centre}</span>
      </Ring>
      <span className="stat-ring-caption">{caption}</span>
      {detail && <span className="stat-ring-detail">{detail}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ Table toggle */

function ChartWithTable({
  chart,
  table,
  tableLabel,
}: {
  chart: ReactNode;
  table: ReactNode;
  tableLabel: string;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div className="chart-block">
      {showTable ? table : chart}
      <button
        type="button"
        className="btn btn-ghost btn-sm chart-toggle"
        aria-pressed={showTable}
        onClick={() => setShowTable((s) => !s)}
      >
        {showTable ? 'Show as chart' : `Show ${tableLabel} as table`}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ Donut */

export interface DonutSegment {
  key: string;
  label: string;
  cents: Cents;
  colour: ChartColour;
  /** Optional CSS colour that overrides `colour`, e.g. a shade of it from `shadeOf`. */
  tint?: string;
}

/**
 * The i-th shade of a chart colour, for slices that all belong to one group: the first is the
 * colour itself, then alternately lighter and darker, further each time, so neighbouring slices
 * stay distinguishable while the whole chart reads as that group's colour.
 */
export function shadeOf(colour: ChartColour, i: number): string {
  if (i === 0) return `var(--chart-${colour})`;
  const step = Math.min(3, Math.ceil(i / 2));
  const amount = [0, 28, 48, 62][step];
  const towards = i % 2 === 1 ? 'white' : 'var(--color-bg)';
  return `color-mix(in oklab, var(--chart-${colour}), ${towards} ${amount}%)`;
}

export function Donut({
  segments,
  totalCents,
  label,
  centreLabel,
  size = 132,
  showPercent = false,
}: {
  segments: DonutSegment[];
  /** The total the segments add up to (shown in the middle). */
  totalCents: Cents;
  /** What the chart shows, e.g. "Spending by category, 1–31 Oct". */
  label: string;
  centreLabel: string;
  size?: number;
  showPercent?: boolean;
}) {
  const thickness = Math.round(size * 0.14);
  const r = (size - thickness) / 2;
  const c = size / 2;
  const gap = segments.length > 1 ? 1.2 : 0;
  let offset = 0;
  const arcs = segments.map((s) => {
    const len = fraction(s.cents, totalCents) * 100;
    const arc = { ...s, start: offset, len: Math.max(0, len - gap) };
    offset += len;
    return arc;
  });
  const spoken = segments
    .map((s) => `${s.label} ${formatZAR(s.cents)} (${percentLabel(s.cents, totalCents)})`)
    .join(', ');

  const legend = (
    <ul className="chart-legend">
      {segments.map((s) => (
        <li key={s.key}>
          <span
            className={`swatch chart-${s.colour}`}
            style={s.tint ? { background: s.tint } : undefined}
            aria-hidden="true"
          />
          <span className="chart-legend-label">{s.label}</span>
          {showPercent && (
            <span className="chart-legend-pct">{percentLabel(s.cents, totalCents)}</span>
          )}
          <Money cents={s.cents} className="chart-legend-value" />
        </li>
      ))}
    </ul>
  );

  const chart = (
    <div className="donut-row">
      <div className="ring" role="img" aria-label={`${label}: ${spoken}`}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle className="ring-track" cx={c} cy={c} r={r} fill="none" strokeWidth={thickness} />
          <g transform={`rotate(-90 ${c} ${c})`}>
            {arcs
              .filter((a) => a.len > 0)
              .map((a) => (
                <circle
                  key={a.key}
                  className={`donut-arc stroke-chart-${a.colour}`}
                  style={a.tint ? { stroke: a.tint } : undefined}
                  cx={c}
                  cy={c}
                  r={r}
                  fill="none"
                  strokeWidth={thickness}
                  pathLength={100}
                  strokeDasharray={`${a.len} 100`}
                  strokeDashoffset={-a.start}
                />
              ))}
          </g>
        </svg>
        <div className="ring-center" aria-hidden="true">
          <span className="ring-figure">
            <Money cents={totalCents} whole />
          </span>
          <span className="ring-caption">{centreLabel}</span>
        </div>
      </div>
      {legend}
    </div>
  );

  const table = (
    <table className="data-table chart-table">
      <caption className="visually-hidden">{label}</caption>
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col" className="amount">
            Share
          </th>
          <th scope="col" className="amount">
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {segments.map((s) => (
          <tr key={s.key}>
            <th scope="row">{s.label}</th>
            <td className="amount">{percentLabel(s.cents, totalCents)}</td>
            <td className="amount">
              <Money cents={s.cents} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return <ChartWithTable chart={chart} table={table} tableLabel="breakdown" />;
}

/* ------------------------------------------------------------------ Paired monthly bars */

export interface MonthBars {
  key: string;
  /** Short axis label, e.g. "Oct". */
  label: string;
  /** Long label for the table and screen readers, e.g. "Oct 2026". */
  longLabel: string;
  incomeCents: Cents;
  spendingCents: Cents;
  netCents: Cents;
}

/** Rounds an axis maximum up to a tidy value (1, 2 or 5 × a power of ten) in rand. */
function niceMaxRand(maxCents: number): number {
  const rand = Math.max(1, maxCents / 100);
  const pow = 10 ** Math.floor(Math.log10(rand));
  const step = [1, 2, 5, 10].find((m) => m * pow >= rand) ?? 10;
  return step * pow;
}

function shortRand(rand: number): string {
  if (rand >= 1_000_000) return `R${rand / 1_000_000}m`;
  if (rand >= 1000) return `R${rand / 1000}k`;
  return `R${rand}`;
}

export function IncomeSpendingBars({ months, label }: { months: MonthBars[]; label: string }) {
  const titleId = useId();
  const width = 340;
  const height = 190;
  const left = 40;
  const right = 6;
  const top = 12;
  const bottom = 26;
  const plotH = height - top - bottom;
  const plotW = width - left - right;
  const maxCents = Math.max(0, ...months.flatMap((m) => [m.incomeCents, m.spendingCents]));
  const maxRand = niceMaxRand(maxCents);
  const ticks = [0, maxRand / 2, maxRand];
  const y = (cents: number) => top + plotH - fraction(cents, maxRand * 100) * plotH;
  const slot = plotW / Math.max(1, months.length);
  const barW = Math.min(16, slot / 3);

  const spoken = months
    .map(
      (m) =>
        `${m.longLabel}: income ${formatZAR(m.incomeCents)}, spending ${formatZAR(m.spendingCents)}`,
    )
    .join('; ');

  const chart = (
    <figure className="bar-chart" aria-labelledby={titleId}>
      <figcaption id={titleId} className="visually-hidden">
        {label}
      </figcaption>
      <div className="chart-key" aria-hidden="true">
        <span>
          <span className="swatch tone-bg-positive" /> Income
        </span>
        <span>
          <span className="swatch tone-bg-negative swatch-hatched" /> Spending
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={`${label}. ${spoken}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              className={t === 0 ? 'chart-axis' : 'chart-grid'}
              x1={left}
              x2={width - right}
              y1={y(t * 100)}
              y2={y(t * 100)}
            />
            <text className="chart-tick" x={left - 6} y={y(t * 100) + 3.5} textAnchor="end">
              {shortRand(t)}
            </text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = left + slot * i + slot / 2;
          const incomeY = y(m.incomeCents);
          const spendY = y(m.spendingCents);
          return (
            <g key={m.key}>
              {m.incomeCents > 0 && (
                <rect
                  className="bar-income"
                  x={cx - barW - 1}
                  y={incomeY}
                  width={barW}
                  height={top + plotH - incomeY}
                  rx={3}
                />
              )}
              {m.spendingCents > 0 && (
                <rect
                  className="bar-spending"
                  x={cx + 1}
                  y={spendY}
                  width={barW}
                  height={top + plotH - spendY}
                  rx={3}
                />
              )}
              <text className="chart-label" x={cx} y={height - 8} textAnchor="middle">
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );

  const table = (
    <div className="table-wrap">
      <table className="data-table chart-table">
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col" className="amount">
              Income
            </th>
            <th scope="col" className="amount">
              Spending
            </th>
            <th scope="col" className="amount">
              Net
            </th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.key}>
              <th scope="row">{m.longLabel}</th>
              <td className="amount">
                <Money cents={m.incomeCents} />
              </td>
              <td className="amount">
                <Money cents={m.spendingCents} />
              </td>
              <td className="amount">
                <Money cents={m.netCents} signed tone />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return <ChartWithTable chart={chart} table={table} tableLabel="months" />;
}

/* ------------------------------------------------------------------ Budget vs actual */

export interface BudgetBar {
  key: string;
  label: string;
  limitCents: Cents;
  spentCents: Cents;
  remainingCents: Cents;
}

export function BudgetBars({ lines, label }: { lines: BudgetBar[]; label: string }) {
  return (
    <ul className="budget-bars" aria-label={label}>
      {lines.map((l) => {
        const over = l.remainingCents < 0;
        const full = !over && l.limitCents > 0 && l.remainingCents === 0;
        const state = over ? 'over' : full ? 'full' : 'ok';
        return (
          <li key={l.key} data-state={state}>
            <div className="budget-bar-head">
              <span className="budget-bar-label">{l.label}</span>
              <span className="budget-bar-figures">
                <Money cents={l.spentCents} whole />
                <span className="faint">
                  {' '}
                  / <Money cents={l.limitCents} whole />
                </span>
              </span>
            </div>
            <div
              className="budget-bar-track"
              role="meter"
              aria-label={`${l.label}: ${formatZAR(l.spentCents)} spent of ${formatZAR(l.limitCents)}`}
              aria-valuemin={0}
              aria-valuemax={Math.max(1, l.limitCents)}
              aria-valuenow={Math.min(l.spentCents, Math.max(1, l.limitCents))}
            >
              <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
                <rect
                  className="budget-bar-bg"
                  x={0}
                  y={0}
                  width={100}
                  height={8}
                  rx={1.5}
                  ry={4}
                />
                {l.spentCents > 0 && (
                  <rect
                    className="budget-bar-fill"
                    x={0}
                    y={0}
                    width={Math.max(2, fraction(l.spentCents, l.limitCents) * 100)}
                    height={8}
                    rx={1.5}
                    ry={4}
                  />
                )}
              </svg>
            </div>
            <span className="budget-bar-note">
              {over ? (
                <>
                  Over by <Money cents={-l.remainingCents} />
                </>
              ) : full ? (
                'Limit reached'
              ) : (
                <>
                  <Money cents={l.remainingCents} /> left
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
