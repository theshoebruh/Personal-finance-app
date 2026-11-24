import Dexie from 'dexie';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/app/App';
import { FunctionCallError, SyncContext, type SyncContextValue } from '@/app/SyncContext';
import { FinanceDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { ensureInitialised } from '@/services/settingsService';

let n = 0;
let db: FinanceDb;
let store: FinanceStore;

beforeEach(async () => {
  localStorage.clear();
  db = new FinanceDb(`ask-ui-${++n}`);
  store = createDexieStore(db);
  await ensureInitialised(store);
});
afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

function renderWith(callFunction: SyncContextValue['callFunction']) {
  const sync = {
    callFunction,
    email: 'me@example.com',
    status: { state: 'idle', lastSyncedAt: null, pending: 0, failed: 0, conflicts: 0, error: null },
  } as unknown as SyncContextValue;
  render(
    <SyncContext.Provider value={sync}>
      <App db={db} store={store} initialPath="/ask" />
    </SyncContext.Provider>,
  );
}

it('asks before sending anything, then answers a suggested question', async () => {
  const calls: unknown[] = [];
  const callFunction = vi.fn(async (_name: string, body: unknown) => {
    calls.push(body);
    if ((body as { probe?: boolean }).probe) return { allowed: true };
    return {
      content: [{ type: 'text', text: 'Most of it went to **Needs**.' }],
      stop_reason: 'end_turn',
    };
  });
  const user = userEvent.setup({ delay: null });
  renderWith(callFunction);

  await user.click(await screen.findByRole('button', { name: 'Turn on Ask' }));
  expect(calls).toEqual([{ probe: true }]);

  await user.click(await screen.findByRole('button', { name: /Where did most of my money go/ }));
  expect(await screen.findByText('Needs')).toContainHTML('strong');
  const sent = calls[1] as { messages: { content: { text: string }[] }[] };
  expect(sent.messages[0]!.content[0]!.text).toMatch(
    /^Today is \d{4}-\d{2}-\d{2}\. Current (pay period|month): /,
  );

  // Turning it off forgets the choice.
  await user.click(screen.getByRole('button', { name: 'Turn off Ask' }));
  expect(await screen.findByRole('button', { name: 'Turn on Ask' })).toBeInTheDocument();
  expect(localStorage.getItem('askOptIn')).toBeNull();
});

it('says so when Ask isn’t enabled for the account', async () => {
  localStorage.setItem('askOptIn', '1');
  renderWith(async () => {
    throw new FunctionCallError(403, 'not_allowed');
  });
  expect(await screen.findByText(/isn’t turned on for your account/)).toBeInTheDocument();
});

it('explains that Ask needs sign-in in local-only mode', async () => {
  render(<App db={db} store={store} initialPath="/ask" />);
  expect(await screen.findByText(/works when you’re signed in/)).toBeInTheDocument();
  // Let the app finish its start-up tidy-up before the database is closed.
  await waitFor(async () => expect(await store.budgetGroups.list()).not.toHaveLength(0));
  await new Promise((r) => setTimeout(r, 50));
});
