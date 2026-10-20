import Dexie from 'dexie';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/app/App';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { ensureInitialised, updateSettings } from '@/services/settingsService';
import { SETTINGS_ID } from '@/domain/models';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;

beforeEach(async () => {
  db = new FinanceDb(`settings-ui-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
  await updateSettings(store, { budgetPeriodMode: 'calendar_month' });
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

it('previews the budget period and switches to payday-to-payday', async () => {
  const user = userEvent.setup({ delay: null });
  render(<App db={db} store={store} initialPath="/settings" />);
  const payday = await screen.findByLabelText('Payday (day of month)');
  await user.clear(payday);
  await user.type(payday, '25');
  expect(screen.getByText(/Current budget period:/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Use payday to payday' }));
  expect(screen.getByLabelText('Budget period')).toHaveValue('pay_period');
  expect(screen.queryByRole('button', { name: 'Use payday to payday' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(async () =>
    expect(await store.settings.get(SETTINGS_ID)).toMatchObject({
      paydayDayOfMonth: 25,
      budgetPeriodMode: 'pay_period',
    }),
  );
});
