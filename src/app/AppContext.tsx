import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { FinanceDb } from '@/data/local-db/db';
import type { FinanceStore } from '@/data/repositories/types';
import type {
  Account,
  AppSettings,
  Budget,
  BudgetGroup,
  Category,
  GoalContribution,
  RecurringRule,
  SavingsGoal,
  Transaction,
  WorkspaceView,
} from '@/domain/models';
import { SETTINGS_ID } from '@/domain/models';
import { type IsoDate, todayInAppZone } from '@/domain/dates';
import { ensureInitialised } from '@/services/settingsService';
import { archiveSettledPendings } from '@/services/pendingCleanup';

export interface FinanceData {
  settings: AppSettings;
  accounts: Account[];
  transactions: Transaction[];
  categories: Category[];
  budgetGroups: BudgetGroup[];
  budgets: Budget[];
  goals: SavingsGoal[];
  goalContributions: GoalContribution[];
  recurringRules: RecurringRule[];
}

interface AppContextValue {
  db: FinanceDb;
  store: FinanceStore;
  view: WorkspaceView;
  setView: (v: WorkspaceView) => void;
  today: IsoDate;
}

const AppContext = createContext<AppContextValue | null>(null);

const VIEW_KEY = 'pfh.workspaceView';

/** Only a non-sensitive UI preference is kept in localStorage; financial data stays in IndexedDB. */
function readStoredView(): WorkspaceView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'personal' || v === 'business' || v === 'combined') return v;
  } catch {
    // Storage unavailable (private mode); fall back to default.
  }
  return 'personal';
}

function useToday(): IsoDate {
  const [today, setToday] = useState(() => todayInAppZone());
  useEffect(() => {
    const tick = () => setToday(todayInAppZone());
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return today;
}

export function AppProvider({
  db,
  store,
  children,
}: {
  db: FinanceDb;
  store: FinanceStore;
  children: ReactNode;
}) {
  const [view, setViewState] = useState<WorkspaceView>(readStoredView);
  const today = useToday();
  const value = useMemo<AppContextValue>(
    () => ({
      db,
      store,
      view,
      today,
      setView: (v) => {
        setViewState(v);
        try {
          localStorage.setItem(VIEW_KEY, v);
        } catch {
          // ignore
        }
      },
    }),
    [db, store, view, today],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

/** Live view of all local data; re-renders whenever IndexedDB changes. Undefined while loading. */
export function useFinanceData(): FinanceData | undefined {
  const { db, store } = useApp();
  useEffect(() => {
    // Set up defaults, then tidy pending purchases whose payment has since gone through.
    void ensureInitialised(store).then(() => archiveSettledPendings(store));
  }, [store]);
  return useLiveQuery(async () => {
    const [
      settings,
      accounts,
      transactions,
      categories,
      budgetGroups,
      budgets,
      goals,
      goalContributions,
      recurringRules,
    ] = await Promise.all([
      db.settings.get(SETTINGS_ID),
      db.accounts.toArray(),
      db.transactions.toArray(),
      db.categories.toArray(),
      db.budgetGroups.toArray(),
      db.budgets.toArray(),
      db.goals.toArray(),
      db.goalContributions.toArray(),
      db.recurringRules.toArray(),
    ]);
    if (!settings) return undefined;
    return {
      settings,
      accounts,
      transactions,
      categories,
      budgetGroups: budgetGroups.sort((a, b) => a.sortOrder - b.sortOrder),
      budgets,
      goals,
      goalContributions,
      recurringRules,
    };
  }, [db]);
}
