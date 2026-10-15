// Connectivity and setup check for the configured Supabase project, using only the public
// (publishable) key from .env.local / .env — exactly what the browser app ships with.
//   npm run check:supabase
// Reports: reachability, auth settings, whether the migrations are applied, and that anonymous
// visitors are denied (row-level security / privileges). Read-only: it writes nothing.
import { loadEnv } from 'vite';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const env = loadEnv(process.env.MODE ?? 'development', process.cwd(), 'VITE_');
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const results = [];
const report = (status, name, detail = '') => results.push({ status, name, detail });

if (!url || !key) {
  console.log('FAIL  VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must both be set.');
  process.exit(1);
}
if (key.startsWith('sb_secret_')) {
  console.log('FAIL  The key is a SECRET key. Use the publishable key; never ship a secret key.');
  process.exit(1);
}
report('PASS', 'Environment variables present', `${url}, key ${key.slice(0, 15)}…`);

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket },
});

// 1. Reachability + auth configuration (public endpoint)
try {
  const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const s = await res.json();
  report('PASS', 'Project reachable; Auth responding');
  report(s.external?.email ? 'PASS' : 'FAIL', 'Email sign-in enabled');
  report(
    s.mailer_autoconfirm ? 'WARN' : 'PASS',
    'Email confirmation required',
    s.mailer_autoconfirm ? 'auto-confirm is on' : '',
  );
  report(
    s.disable_signup ? 'PASS' : 'INFO',
    'New sign-ups disabled',
    s.disable_signup ? '' : 'still open — disable after creating your account',
  );
} catch (e) {
  report('FAIL', 'Project reachable', e.message);
}

// 2. Session handling works (no session expected for this script)
const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
report(
  !sessionError && sessionData.session === null ? 'PASS' : 'FAIL',
  'Client session handling',
  sessionError?.message ?? '',
);

// 3. Migrations applied? Anonymous access must be refused by privileges/RLS.
const TABLES = [
  'accounts',
  'categories',
  'import_batches',
  'transactions',
  'budgets',
  'goals',
  'goal_contributions',
  'recurring_rules',
  'import_profiles',
  'categorisation_rules',
  'projects',
  'invoices',
  'settings',
];
let missing = 0;
let exposed = 0;
for (const t of TABLES) {
  const { data, error } = await supabase.from(t).select('*').limit(1);
  if (error?.code === 'PGRST205') missing++;
  else if (!error || (data && data.length > 0)) exposed++;
  else if (error.code !== '42501') report('WARN', `Table ${t}`, `${error.code} ${error.message}`);
}
if (missing === TABLES.length) {
  report(
    'INFO',
    'Migrations applied',
    'not yet — the app tables do not exist (run: npx supabase db push)',
  );
} else if (missing > 0) {
  report('FAIL', 'Migrations applied', `${missing} of ${TABLES.length} tables missing`);
} else {
  report('PASS', 'Migrations applied', `all ${TABLES.length} tables exist`);
  report(
    exposed === 0 ? 'PASS' : 'FAIL',
    'Anonymous visitors cannot read any table',
    exposed ? `${exposed} exposed` : '',
  );
  const rpc = await supabase.rpc('sync_pull', {});
  report(
    rpc.error?.code === '42501' ? 'PASS' : 'FAIL',
    'Anonymous visitors cannot call the sync functions',
    rpc.error ? '' : 'sync_pull answered without a session',
  );
}

for (const r of results)
  console.log(`${r.status.padEnd(4)}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
