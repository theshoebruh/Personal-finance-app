import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router';
import type { FinanceDb } from '@/data/local-db/db';
import type { FinanceStore } from '@/data/repositories/types';
import { AppProvider } from './AppContext';
import { Layout } from './Layout';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { TransactionsPage } from '@/features/transactions/TransactionsPage';
import { AccountsPage } from '@/features/accounts/AccountsPage';
import { BudgetsPage } from '@/features/budgets/BudgetsPage';
import { GoalsPage } from '@/features/goals/GoalsPage';
import { BusinessPage } from '@/features/business/BusinessPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { SettingsPage } from '@/features/settings/SettingsPage';

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
        <Route path="*" element={<DashboardPage />} />
      </Route>
    </Routes>
  );
}

export function App({
  db,
  store,
  initialPath,
}: {
  db: FinanceDb;
  store: FinanceStore;
  /** For tests: render with an in-memory router at this path. */
  initialPath?: string;
}) {
  return (
    <AppProvider db={db} store={store}>
      {initialPath ? (
        <MemoryRouter initialEntries={[initialPath]}>
          <AppRoutes />
        </MemoryRouter>
      ) : (
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      )}
    </AppProvider>
  );
}
