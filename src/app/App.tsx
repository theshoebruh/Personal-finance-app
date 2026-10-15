import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router';
import type { FinanceDb } from '@/data/local-db/db';
import type { FinanceStore } from '@/data/repositories/types';
import { AppProvider } from './AppContext';
import { Layout } from './Layout';
import { ConfirmProvider } from '@/components/ConfirmDialog';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { TransactionsPage } from '@/features/transactions/TransactionsPage';
import { AccountsPage } from '@/features/accounts/AccountsPage';
import { BudgetsPage } from '@/features/budgets/BudgetsPage';
import { GoalsPage } from '@/features/goals/GoalsPage';
import { BusinessPage } from '@/features/business/BusinessPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { ImportPage } from '@/features/imports/ImportPage';

function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="transactions" element={<TransactionsPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="budgets" element={<BudgetsPage />} />
        <Route path="goals" element={<GoalsPage />} />
        <Route path="business" element={<BusinessPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="*" element={<DashboardPage />} />
      </Route>
    </Routes>
  );
}

export function App({
  db,
  store,
  initialPath,
  routing = 'browser',
}: {
  db: FinanceDb;
  store: FinanceStore;
  /** For tests: render with an in-memory router at this path. */
  initialPath?: string;
  /**
   * "memory" keeps navigation inside the page, for hosts where the URL can't be used for routing
   * (e.g. an embedded artifact viewer). Defaults to normal browser URLs.
   */
  routing?: 'browser' | 'memory';
}) {
  return (
    <AppProvider db={db} store={store}>
      <ConfirmProvider>
        {initialPath || routing === 'memory' ? (
          <MemoryRouter initialEntries={[initialPath ?? '/']}>
            <AppRoutes />
          </MemoryRouter>
        ) : (
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        )}
      </ConfirmProvider>
    </AppProvider>
  );
}
