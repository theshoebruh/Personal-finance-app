import { useCallback, useEffect, useMemo, useState } from 'react';
import Dexie from 'dexie';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { App } from '@/app/App';
import { SyncContext, type SyncContextValue } from '@/app/SyncContext';
import { DB_NAME, FinanceDb, userDbName } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import type { FinanceStore } from '@/data/repositories/types';
import { prepareDevice } from '@/data/sync/bootstrap';
import { type SyncRemote, createSupabaseRemote } from '@/data/sync/remote';
import { SyncEngine, type SyncStatus } from '@/data/sync/syncEngine';
import { createTrackedStore } from '@/data/sync/trackedStore';
import { subscribeToChanges } from '@/data/sync/realtime';
import { exportBackup, restoreBackup } from '@/services/backupService';
import { SetNewPassword, SignInScreen } from './SignInScreen';

interface GateProps {
  client: SupabaseClient;
  /** Injectable for tests; defaults to the Supabase sync functions. */
  createRemote?: (client: SupabaseClient) => SyncRemote;
  routing?: 'browser' | 'memory';
  initialPath?: string;
}

/**
 * Protects the whole app when sync is configured: nothing that holds financial data renders until
 * there is a valid session. Each user gets their own local database.
 */
export function AuthGate({
  client,
  createRemote = createSupabaseRemote,
  routing,
  initialPath,
}: GateProps) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    let active = true;
    void client.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data } = client.auth.onAuthStateChange((event, next) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      // Keep the same session object across token refreshes so the app doesn't remount.
      setSession((prev) => (prev?.user.id === next?.user.id && next ? prev : next));
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  if (session === undefined) {
    return (
      <main className="auth-screen">
        <p className="muted" role="status">
          Checking your sign-in…
        </p>
      </main>
    );
  }
  if (recovering && session) {
    return <SetNewPassword client={client} onDone={() => setRecovering(false)} />;
  }
  if (!session) return <SignInScreen client={client} />;
  return (
    <SyncedApp
      key={session.user.id}
      client={client}
      userId={session.user.id}
      email={session.user.email ?? ''}
      createRemote={createRemote}
      routing={routing}
      initialPath={initialPath}
    />
  );
}

type Boot =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; db: FinanceDb; store: FinanceStore; engine: SyncEngine };

function SyncedApp({
  client,
  userId,
  email,
  createRemote,
  routing,
  initialPath,
}: {
  client: SupabaseClient;
  userId: string;
  email: string;
  createRemote: (client: SupabaseClient) => SyncRemote;
  routing?: 'browser' | 'memory' | undefined;
  initialPath?: string | undefined;
}) {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [localOnlyRecordCount, setLocalOnlyRecordCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const db = new FinanceDb(userDbName(userId));
    let engine: SyncEngine | null = null;
    const store = createTrackedStore(db, () => engine?.notifyLocalChange());
    engine = new SyncEngine(db, createRemote(client));
    const unsubscribe = engine.subscribe(setStatus);
    const stopListening = subscribeToChanges(client, userId, () => engine?.notifyLocalChange(500));

    prepareDevice(engine, store)
      .then(() => {
        if (cancelled) return;
        engine!.start();
        setBoot({ phase: 'ready', db, store, engine: engine! });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setBoot({
          phase: 'error',
          message:
            e instanceof Error && /fetch|network|offline|reach/i.test(e.message)
              ? 'This device needs to download your data once before it can be used. Connect to the internet and try again.'
              : `Couldn’t load your data: ${e instanceof Error ? e.message : String(e)}`,
        });
      });

    return () => {
      cancelled = true;
      unsubscribe();
      engine?.stop();
      stopListening();
      db.close();
    };
  }, [client, userId, createRemote, attempt]);

  // Records saved on this device before signing in can be copied into the account once.
  useEffect(() => {
    void (async () => {
      if (!(await Dexie.exists(DB_NAME))) return;
      const local = new FinanceDb(DB_NAME);
      try {
        const count = (await local.accounts.count()) + (await local.transactions.count());
        setLocalOnlyRecordCount(count);
      } finally {
        local.close();
      }
    })().catch(() => undefined);
  }, [userId]);

  const signOut = useCallback(
    async ({ removeLocalData }: { removeLocalData: boolean }) => {
      if (boot.phase === 'ready') {
        await boot.engine.syncNow().catch(() => undefined);
        boot.engine.stop();
      }
      await client.auth.signOut();
      if (removeLocalData) {
        if (boot.phase === 'ready') boot.db.close();
        await Dexie.delete(userDbName(userId));
      }
    },
    [boot, client, userId],
  );

  const value = useMemo<SyncContextValue | null>(() => {
    if (boot.phase !== 'ready' || !status) return null;
    return {
      engine: boot.engine,
      status,
      email,
      signOut,
      localOnlyRecordCount,
      async copyLocalOnlyData() {
        const local = new FinanceDb(DB_NAME);
        try {
          const backup = await exportBackup(createDexieStore(local));
          // Keep the account's settings; bring over records only.
          backup.data.settings = [];
          await restoreBackup(boot.store, backup, 'merge');
        } finally {
          local.close();
        }
        await Dexie.delete(DB_NAME);
        setLocalOnlyRecordCount(0);
      },
      async discardLocalOnlyData() {
        await Dexie.delete(DB_NAME);
        setLocalOnlyRecordCount(0);
      },
    };
  }, [boot, status, email, signOut, localOnlyRecordCount]);

  if (boot.phase === 'loading') {
    return (
      <main className="auth-screen">
        <p className="muted" role="status">
          Loading your data…
        </p>
      </main>
    );
  }
  if (boot.phase === 'error') {
    return (
      <main className="auth-screen">
        <div className="card stack auth-card" role="alert">
          <h1>Not ready yet</h1>
          <p>{boot.message}</p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setAttempt((a) => a + 1)}
            >
              Try again
            </button>
            <button type="button" className="btn" onClick={() => void client.auth.signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </main>
    );
  }
  return (
    <SyncContext.Provider value={value}>
      <App
        db={boot.db}
        store={boot.store}
        routing={routing ?? 'browser'}
        {...(initialPath ? { initialPath } : {})}
      />
    </SyncContext.Provider>
  );
}
