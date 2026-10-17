import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BudgetBars, Donut, IncomeSpendingBars, Ring, fraction, percentLabel } from './charts';

/** Normalise the narrow no-break spaces Intl uses in en-ZA currency. */
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s/g, ' ');

describe('chart helpers', () => {
  it('clamps fractions to 0–1 and survives a zero or missing total', () => {
    expect(fraction(50, 200)).toBe(0.25);
    expect(fraction(300, 200)).toBe(1);
    expect(fraction(-5, 200)).toBe(0);
    expect(fraction(5, 0)).toBe(0);
    expect(percentLabel(581_000, 1_200_000)).toBe('48%');
  });
});

describe('Ring', () => {
  it('describes itself to screen readers and fills the right share of the circle', () => {
    const { container } = render(
      <Ring value={0.48} label="48% of this period's budget left">
        <span>48%</span>
      </Ring>,
    );
    expect(screen.getByRole('img', { name: "48% of this period's budget left" })).toBeVisible();
    const arc = container.querySelector('.ring-value');
    expect(arc).toHaveAttribute('stroke-dasharray', '48 100');
    expect(arc).toHaveAttribute('pathLength', '100');
  });

  it('draws no arc for an empty ring', () => {
    const { container } = render(<Ring value={0} label="Nothing yet" />);
    expect(container.querySelector('.ring-value')).toBeNull();
  });
});

describe('Donut', () => {
  const segments = [
    { key: 'rent', label: 'Rent', cents: 450_000, colour: 1 as const },
    { key: 'food', label: 'Groceries', cents: 150_000, colour: 2 as const },
  ];

  it('labels each segment in words, with amounts, so colour is not the only signal', () => {
    render(
      <Donut
        label="Spending by category"
        centreLabel="spent"
        totalCents={600_000}
        segments={segments}
        showPercent
      />,
    );
    const img = screen.getByRole('img', { name: /Spending by category/ });
    expect(img.getAttribute('aria-label')?.replace(/\s/g, ' ')).toContain(
      'Rent R 4 500,00 (75%), Groceries R 1 500,00 (25%)',
    );
    const legend = screen.getByRole('list');
    expect(text(within(legend).getByText('Rent').closest('li'))).toContain('75%R 4 500,00');
    expect(text(img)).toContain('R 6 000');
  });

  it('switches to a table with the exact figures', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <Donut
        label="Spending by category"
        centreLabel="spent"
        totalCents={600_000}
        segments={segments}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Show breakdown as table' }));
    const table = screen.getByRole('table', { name: 'Spending by category' });
    const rows = within(table).getAllByRole('row');
    expect(rows.map((r) => text(r))).toEqual([
      'CategoryShareAmount',
      'Rent75%R 4 500,00',
      'Groceries25%R 1 500,00',
    ]);
    await user.click(screen.getByRole('button', { name: 'Show as chart' }));
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('IncomeSpendingBars', () => {
  const months = [
    {
      key: '2026-09-01',
      label: 'Sep',
      longLabel: 'Sep 2026',
      incomeCents: 0,
      spendingCents: 0,
      netCents: 0,
    },
    {
      key: '2026-10-01',
      label: 'Oct',
      longLabel: 'Oct 2026',
      incomeCents: 1_200_000,
      spendingCents: 751_000,
      netCents: 449_000,
    },
  ];

  it('draws one bar per non-zero value on a tidy axis and reads out every month', () => {
    const { container } = render(
      <IncomeSpendingBars label="Income and spending" months={months} />,
    );
    const img = screen.getByRole('img', { name: /Income and spending/ });
    expect(img.getAttribute('aria-label')?.replace(/\s/g, ' ')).toContain(
      'Oct 2026: income R 12 000,00, spending R 7 510,00',
    );
    expect(container.querySelectorAll('.bar-income')).toHaveLength(1);
    expect(container.querySelectorAll('.bar-spending')).toHaveLength(1);
    // R12 000 rounds up to an axis of R20k.
    expect([...container.querySelectorAll('.chart-tick')].map((t) => t.textContent)).toEqual([
      'R0',
      'R10k',
      'R20k',
    ]);
  });

  it('has a table alternative with net per month', async () => {
    const user = userEvent.setup({ delay: null });
    render(<IncomeSpendingBars label="Income and spending" months={months} />);
    await user.click(screen.getByRole('button', { name: 'Show months as table' }));
    const row = screen.getByRole('row', { name: /Oct 2026/ });
    expect(text(row)).toBe('Oct 2026R 12 000,00R 7 510,00+R 4 490,00');
  });
});

describe('BudgetBars', () => {
  it('writes out what is left, a reached limit, and an overspend', () => {
    render(
      <BudgetBars
        label="Budget vs actual"
        lines={[
          {
            key: 'g',
            label: 'Groceries',
            limitCents: 300_000,
            spentCents: 81_000,
            remainingCents: 219_000,
          },
          { key: 'r', label: 'Rent', limitCents: 450_000, spentCents: 450_000, remainingCents: 0 },
          {
            key: 'e',
            label: 'Eating out',
            limitCents: 80_000,
            spentCents: 95_000,
            remainingCents: -15_000,
          },
        ]}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Budget vs actual' })).getAllByRole(
      'listitem',
    );
    expect(text(items[0]!)).toContain('R 2 190,00 left');
    expect(text(items[1]!)).toContain('Limit reached');
    expect(text(items[2]!)).toContain('Over by R 150,00');
    expect(items[2]).toHaveAttribute('data-state', 'over');
    expect(
      screen.getByRole('meter', { name: /Eating out: R\s950,00 spent of R\s800,00/ }),
    ).toBeInTheDocument();
  });
});
