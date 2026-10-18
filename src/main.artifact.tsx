import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import { App } from '@/app/App';
import { ErrorBoundary } from '@/app/ErrorBoundary';
import '@/styles/app.css';

// Entry for the Claude artifact build: navigation stays inside the page and there is no service
// worker (the viewer's sandbox allows neither URL routing nor service workers).
const db = getDb();
const store = createDexieStore(db);

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App db={db} store={store} routing="memory" />
    </ErrorBoundary>
  </StrictMode>,
);
