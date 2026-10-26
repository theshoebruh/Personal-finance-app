import { Link, useNavigate } from 'react-router';
import { useApp } from '@/app/AppContext';
import { type GroupLine, isGoalToReach } from '@/domain/calculations/buckets';
import { formatZAR } from '@/domain/money';
import { currentBalance } from '@/domain/calculations/balances';
import { loadDemoData } from '@/services/demoService';
import { Alert, Card, CountUpMoney, DateText, Loading, Money, useStatus } from '@/components/ui';
import { Icon } from '@/components/icons';
import { openGroup, shouldAnimateClick } from '@/app/viewTransition';
import { PageHeader } from '@/components/PageHeader';
import { Donut, Ring, fraction, type DonutSegment, type RingTone } from '@/components/charts';
import { UNCATEGORISED_COLOUR, groupColour, groupHint, useBuckets } from './useBuckets';

/**
 * Rings always use the group's own colour so the groups are easy to tell apart; whether a
 * group is over, nearly at or past its goal is said in words (see `LeftText`) and, when over, by
 * the card's red edge.
 */
export function ringTone(line: GroupLine): RingTone {
  return `chart-${groupColour(line.group)}`;
}

export function percentText(p: number | null): string {
  return p === null ? '–' : `${p.toLocaleString('en-ZA', { maximumFractionDigits: 1 })}%`;
}

/** Over budget: a spending group past its goal, or less than nothing left over. */
export function isOver(line: GroupLine): boolean {
  if (line.group.kind === 'leftover') return line.actualCents < 0;
  return !isGoalToReach(line.group) && line.leftCents < 0;
}

/**
 * Status in words. Spending groups: "R152 left", "Almost at goal · R40 left" (85%+), "R796
 * over". Savings and Buffer count up: "R85 to go" or "Goal reached ✓"; a negative Buffer means
 * spending is more than income.
 */
export function LeftText({ line }: { line: GroupLine }) {
  if (isGoalToReach(line.group)) {
    if (line.group.kind === 'leftover' && line.actualCents < 0) {
      return (
        <span className="negative">
          Spent <Money cents={-line.actualCents} /> more than income
        </span>
      );
    }
    const toGo = line.targetCents - line.actualCents;
    return toGo <= 0 ? (
      <span className="positive">Goal reached ✓</span>
    ) : (
      <span>
        <Money cents={toGo} /> to go
      </span>
    );
  }
  if (line.leftCents < 0) {
    return (
      <span className="negative">
        <Money cents={-line.leftCents} /> over
      </span>
    );
  }
  const almost = line.targetCents > 0 && line.actualCents >= line.targetCents * 0.85;
  return almost ? (
    <span className="warning-text">
      Almost at goal · <Money cents={line.leftCents} /> left
    </span>
  ) : (
    <span>
      <Money cents={line.leftCents} /> left
    </span>
  );
}

function GroupCard({ line }: { line: GroupLine }) {
  const name = line.group.name;
  const hint = groupHint(line.group);
  const over = isOver(line);
  const navigate = useNavigate();
  const to = `/group/${line.group.id}`;
  return (
    <Link
      to={to}
      className={`group-card group-tone-${groupColour(line.group)}`}
      data-over={over || undefined}
      onClick={(e) => {
        if (!shouldAnimateClick(e)) return;
        e.preventDefault();
        openGroup(navigate, to, e.currentTarget);
      }}
    >
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
        {hint && <span className="group-card-hint">{hint}</span>}
        <span className="group-card-amounts">
          <Money cents={line.actualCents} /> <span className="faint">of</span>{' '}
          <Money cents={line.targetCents} />
        </span>
        <span className="group-card-left">
          <LeftText line={line} />
        </span>
      </span>
      <Icon name="chevron-right" size={18} />
    </Link>
  );
}

export function HomePage() {
  const { store, today } = useApp();
  const buckets = useBuckets();
  const { run, statusNode } = useStatus();
  if (!buckets) return <Loading />;
  const { data, period, summary, dayNumber, totalDays } = buckets;
  const balance = currentBalance(data.accounts, data.transactions);
  const sinceWhen = period.mode === 'pay_period' ? 'Since payday' : 'This month';

  if (data.accounts.length === 0) {
    return (
      <>
        <PageHeader title="Welcome" />
        <Card className="hero onboarding">
          <h2>Your money, sorted into groups</h2>
          <p className="muted">
            Import your bank statement and every transaction is sorted into Needs, Wants and
            Savings, or groups of your own. You see what you spent, what’s left, and how close you
            are to your goals.
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

  const spendLines = summary.lines.filter((l) => l.group.kind === 'spending');
  const leftover = summary.lines.find((l) => l.group.kind === 'leftover');
  const segments: DonutSegment[] = [
    ...spendLines
      .filter((l) => l.actualCents > 0)
      .map((l) => ({
        key: l.group.id,
        label: l.group.name,
        cents: l.actualCents,
        colour: groupColour(l.group),
      })),
    ...(summary.uncategorisedCents > 0
      ? [
          {
            key: 'uncategorised',
            label: 'No category yet',
            cents: summary.uncategorisedCents,
            colour: UNCATEGORISED_COLOUR,
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
        <p className="hero-label">
          Current balance
          {balance.accountCount > 1 && (
            <span className="hero-label-note"> · {balance.accountCount} spendable accounts</span>
          )}
        </p>
        <p className="hero-amount">
          <CountUpMoney cents={balance.afterPendingCents} countKey="home-balance" split />
        </p>
        {balance.pendingCents !== 0 && (
          <p className="hero-sub">
            Includes <Money cents={Math.abs(balance.pendingCents)} /> still pending (your bank’s
            balance before it clears: <Money cents={balance.postedCents} />)
          </p>
        )}
        <div className="totals-row">
          <div>
            <span className="totals-label">Income</span>
            <CountUpMoney cents={summary.incomeCents} countKey="home-income" className="positive" />
          </div>
          <div>
            <span className="totals-label">Spent</span>
            <CountUpMoney cents={summary.expenseCents} countKey="home-spent" />
          </div>
          <div>
            <span className="totals-label">Left this period</span>
            <CountUpMoney cents={summary.leftCents} countKey="home-left" tone />
          </div>
        </div>
        <p className="period-explainer small muted">
          {summary.leftCents < 0 ? (
            <>
              {sinceWhen}, <Money cents={-summary.leftCents} /> more went out than came in. That
              comes out of money you already had, not an overdraft.
            </>
          ) : (
            <>
              {sinceWhen}, you’ve spent <Money cents={summary.leftCents} /> less than came in.
            </>
          )}
          {summary.pendingOutCents > 0 && (
            <>
              {' '}
              Spent includes <Money cents={summary.pendingOutCents} /> still pending.
            </>
          )}
        </p>
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
          <GroupCard key={l.group.id} line={l} />
        ))}
        {leftover && <GroupCard line={leftover} />}
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
