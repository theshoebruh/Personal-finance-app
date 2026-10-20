import Dexie from 'dexie';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SupabaseClient } from '@supabase/supabase-js';
import { userDbName } from '@/data/local-db/db';
import { FakeRemote } from '@/data/sync/fakeRemote';
import { AuthGate } from './AuthGate';

type Listener = (event: string, session: unknown) => void;

/** Minimal stand-in for supabase.auth: one known user, events like the real client. */
function fakeClient(userId: string, email = 'me@example.test', password = 'Correct-horse-1') {
  let session: { user: { id: string; email: string } } | null = null;
  const listeners = new Set<Listener>();
  const emit = (event: string) => listeners.forEach((l) => l(event, session));
  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (cb: Listener) => {
        listeners.add(cb);
        return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
      },
      signInWithPassword: async (creds: { email: string; password: string }) => {
        if (creds.email !== email || creds.password !== password) {
          return { data: { session: null }, error: { message: 'Invalid login credentials' } };
        }
        session = { user: { id: userId, email } };
        emit('SIGNED_IN');
        return { data: { session }, error: null };
      },
      signOut: async () => {
        session = null;
        emit('SIGNED_OUT');
        return { error: null };
      },
      signUp: async () => ({ data: { session: null, user: { id: 'new' } }, error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      updateUser: async () => ({ data: {}, error: null }),
    },
    channel() {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: async () => 'ok',
  };
  return client as unknown as SupabaseClient;
}

let n = 0;
const userId = () => `user-${Date.now()}-${++n}`;

afterEach(async () => {
  for (const name of await Dexie.getDatabaseNames()) await Dexie.delete(name);
});

async function signIn(user: ReturnType<typeof userEvent.setup>, password = 'Correct-horse-1') {
  await user.type(await screen.findByLabelText('Email'), 'me@example.test');
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('authentication', () => {
  it('protects the app behind sign-in and validates the form', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <AuthGate
        client={fakeClient(userId())}
        createRemote={() => new FakeRemote()}
        initialPath="/"
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText(/safe to spend/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('explains a wrong password', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <AuthGate
        client={fakeClient(userId())}
        createRemote={() => new FakeRemote()}
        initialPath="/"
      />,
    );
    await signIn(user, 'wrong-password');
    expect(
      await screen.findByText('That email and password don’t match an account.'),
    ).toBeInTheDocument();
  });

  it('loads the signed-in user’s data, shows sync status, and signing out removes the device copy', async () => {
    const user = userEvent.setup({ delay: null });
    const id = userId();
    render(
      <AuthGate
        client={fakeClient(id)}
        createRemote={() => new FakeRemote()}
        initialPath="/settings"
      />,
    );
    await signIn(user);

    const card = await screen.findByRole('region', { name: 'Sync and account' });
    expect(within(card).getByText('me@example.test')).toBeInTheDocument();
    await waitFor(() => expect(within(card).getAllByText('Synced').length).toBeGreaterThan(0));
    expect(await Dexie.exists(userDbName(id))).toBe(true);

    await user.click(within(card).getByRole('button', { name: 'Sign out' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Sign out?' });
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    await waitFor(async () => expect(await Dexie.exists(userDbName(id))).toBe(false));
  });

  it('asks a new device to connect for its first download, then recovers', async () => {
    const user = userEvent.setup({ delay: null });
    const remote = new FakeRemote();
    remote.offline = true;
    render(<AuthGate client={fakeClient(userId())} createRemote={() => remote} initialPath="/" />);
    await signIn(user);
    expect(await screen.findByText(/needs to download your data once/)).toBeInTheDocument();
    remote.offline = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/your money in five groups/i)).toBeInTheDocument();
  });
});
