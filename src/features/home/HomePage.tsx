import { Link } from 'react-router';
import { useApp } from '@/app/AppContext';
import { BUCKET_LABELS, type Bucket } from '@/domain/models';
import type { BucketLine } from '@/domain/calculations/buckets';
import { formatZAR } from '@/domain/money';
import { loadDemoData } from '@/services/demoService';
import { Alert, Card, DateText, Loading, Money, useStatus } from '@/components/ui';
import { PageHeader } from '@/components/PageHeader';
import { Donut, Ring, fraction, type DonutSegment, type RingTone } from '@/components/charts';
import { BUCKET_COLOUR, BUCKET_HINT, useBuckets } from './useBuckets';

/** Ring colour: the group's own colour, amber near the target, red over it. */
export function ringTone(line: BucketLine): RingTone {
  if (line.bucket === 'buffer') {
    return line.actualCents < 0 ? 'negative' : line.leftCents < 0 ? 'warning' : 'positive';
  }
  if (line.leftCents < 0) return 'negative';
  if (line.targetCents > 0 && line.actualCents >= line.targetCents * 0.85) return 'warning';
  return `chart-${BUCKET_COLOUR[line.bucket]}`;
}

export function percentText(p: number | null): string {
  return p === null ? '–' : `${p.toLocaleString('en-ZA', { maximumFractionDigits: 1 })}%`;
}

/** "R152 left", "R796 over" or, for Buffer, how it compares with its target. */
export function LeftText({ line }: { line: BucketLine }) {
  if (line.bucket === 'buffer') {
    return line.leftCents >= 0 ? (
      <span className="positive">On target</span>
    ) : (
      <span className="warning-text">
        <Money cents={-line.leftCents} /> under target
      </span>
    );
  }
  return line.leftCents >= 0 ? (
    <span>
      <Money cents={line.leftCents} /> left
    </span>
  ) : (
    <span className="negative">
      <Money cents={-line.leftCents} /> over
    </span>
  );
}

function GroupCard({ line }: { line: BucketLine }) {
  const name = BUCKET_LABELS[line.bucket];
  const over = line.bucket !== 'buffer' && line.leftCents < 0;
  return (
    <Link to={`/group/${line.bucket}`} className="group-card" data-over={over || undefined}>
      <Ring
        value={fraction(Math.max(0, line.actualCents), Math.max(1, line.targetCents))}
        label={`${name}: ${formatZAR(line.actualCents)} of ${formatZAR(line.targetCents)} target, ${percentText(line.actualPercent)} of income (goal ${line.targetPercent}%)`}
        size={76}
        thickness={8}
        tone={ringTone(line)}
      >
        <span className="group-card-pct">{percentText(line.actualPercent)}</span>
      </Ring>
      <span className="group-card-body">
        <span className="group-card-title">
          {name} <span className="faint">· goal {line.targetPercent}%</span>
        </span>
        <span className="group-card-hint">{BUCKET_HINT[line.bucket]}</span>
        <span className="group-card-amounts">
          <Money cents={line.actualCents} /> <span className="faint">of</span>{' '}
          <Money cents={line.targetCents} />
        </span>
        <span className="group-card-left">
          <LeftText line={line} />
        </span>
      </span>
    </Link>
  );
}

export function HomePage() {
  const { store, today } = useApp();
  const buckets = useBuckets();
  const { run, statusNode } = useStatus();
  if (!buckets) return <Loading />;
  const { data, period, summary, dayNumber, totalDays } = buckets;

  if (data.accounts.length === 0) {
    return (
      <>
        <PageHeader title="Welcome" />
        <Card className="hero onboarding">
          <h2>Your money in five groups</h2>
          <p className="muted">
            Import your bank statement and every transaction is sorted into Needs, Wants, Savings
            and RF. You see what you spent, what’s left, and how close you are to your goals.
          </p>
          <ol className="steps-list">
            <li>
              <span className="steps-num" aria-hidden="true">
                1
              </span>
              <span>
                <Link to="/accounts">Add your bank account</Link> with its balance.
              </span>
            </li>
            <li>
              <span className="steps-num" aria-hidden="true">
                2
              </span>
              <span>
                <Link to="/import">Import a statement</Link> (CSV from your banking app).
              </span>
            </li>
            <li>
              <span className="steps-num" aria-hidden="true">
                3
              </span>
              <span>Check the categories; fix any it got wrong and it learns for next time.</span>
            </li>
          </ol>
          <div className="btn-row">
            <Link className="btn btn-primary btn-lg" to="/accounts">
              Add your bank account
            </Link>
            <button
              type="button"
              className="btn btn-lg"
              onClick={() =>
                void run(
                  () => loadDemoData(store, today),
                  'Demo data loaded — clear it any time in Settings',
                )
              }
            >
              Explore with demo data
            </button>
          </div>
        </Card>
        {statusNode}
      </>
    );
  }

  const spendLines = summary.lines.filter((l) => l.bucket !== 'buffer');
  const buffer = summary.lines.find((l) => l.bucket === 'buffer')!;
  const segments: DonutSegment[] = [
    ...spendLines
      .filter((l) => l.actualCents > 0)
      .map((l) => ({
        key: l.bucket,
        label: BUCKET_LABELS[l.bucket],
        cents: l.actualCents,
        colour: BUCKET_COLOUR[l.bucket as Bucket],
      })),
    ...(summary.uncategorisedCents > 0
      ? [
          {
            key: 'uncategorised',
            label: 'No category yet',
            cents: summary.uncategorisedCents,
            colour: BUCKET_COLOUR.uncategorised,
          },
        ]
      : []),
  ];
  const hasDemo = data.accounts.some((a) => a.isDemo);

  return (
    <>
      <PageHeader
        title="Home"
        subtitle={
          <>
            <DateText date={period.start} /> – <DateText date={period.end} /> · day {dayNumber} of{' '}
            {totalDays}
          </>
        }
      />
      {hasDemo && (
        <Alert tone="info">
          You’re looking at demo data. <Link to="/settings">Clear it in Settings</Link> when you’re
          ready.
        </Alert>
      )}

      <Card className="hero">
        <p className="hero-label">Left this period</p>
        <p className="hero-amount">
          <Money cents={summary.leftCents} />
        </p>
        <div className="totals-row">
          <div>
            <span className="totals-label">Income</span>
            <Money cents={summary.incomeCents} className="positive" />
          </div>
          <div>
            <span className="totals-label">Spent</span>
            <Money cents={summary.expenseCents} />
          </div>
          <div>
            <span className="totals-label">Left</span>
            <Money cents={summary.leftCents} tone />
          </div>
        </div>
        {segments.length > 0 && (
          <Donut
            segments={segments}
            totalCents={summary.expenseCents}
            label="Spending by group this period"
            centreLabel="spent"
            showPercent
          />
        )}
      </Card>

      {summary.uncategorisedCents > 0 && (
        <Alert
          tone="warning"
          action={
            <Link className="btn btn-sm" to="/transactions?status=needs_review">
              Sort them
            </Link>
          }
        >
          <Money cents={summary.uncategorisedCents} /> of spending has no category yet, so it isn’t
          in any group.
        </Alert>
      )}
      {summary.targetTotalPercent !== 100 && (
        <Alert tone="info">
          Your group goals add up to {summary.targetTotalPercent}%, not 100%.{' '}
          <Link to="/categories">Adjust them</Link>.
        </Alert>
      )}

      <h2 className="section-title">Groups</h2>
      <div className="group-grid">
        {spendLines.map((l) => (
          <GroupCard key={l.bucket} line={l} />
        ))}
        <GroupCard line={buffer} />
      </div>

      {summary.incomeByCategory.length > 0 && (
        <Card title="Income">
          <ul className="list">
            {summary.incomeByCategory.map((c) => (
              <li key={c.categoryId || 'none'}>
                <span>{c.name}</span>
                <Money cents={c.cents} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      {statusNode}
    </>
  );
}
