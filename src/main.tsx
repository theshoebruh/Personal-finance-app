import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getDb } from '@/data/local-db/db';
import { createDexieStore } from '@/data/repositories/dexieStore';
import { App } from '@/app/App';
import { UpdatePrompt } from '@/app/UpdatePrompt';
import '@/styles/app.css';

const db = getDb();
const store = createDexieStore(db);

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

createRoot(root).render(
  <StrictMode>
    <App db={db} store={store} />
    <UpdatePrompt />
  </StrictMode>,
);
