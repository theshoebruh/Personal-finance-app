import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import { App } from '@/app/App';
import { AuthGate } from '@/app/auth/AuthGate';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import { UpdatePrompt } from '@/app/UpdatePrompt';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, SYNC_ENABLED } from '@/app/env';
import { createSupabaseBrowserClient } from '@/data/sync/supabaseClient';
import '@/styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

function LocalOnlyApp() {
  const db = getDb();
  return <App db={db} store={createDexieStore(db)} />;
}

// With Supabase configured the app requires sign-in and syncs; otherwise it is local-only.
const content = SYNC_ENABLED ? (
  <AuthGate client={createSupabaseBrowserClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)} />
) : (
  <LocalOnlyApp />
);

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>{content}</ErrorBoundary>
    <UpdatePrompt />
  </StrictMode>,
);
