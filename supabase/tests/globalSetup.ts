import { execSync } from 'node:child_process';

/**
 * Reads the local stack's API URL and publishable key from `supabase status`. Only the public
 * (publishable/anon) key is used: tests act as real signed-in users, never with a service key.
 */
export default function setup() {
  if (process.env.SUPABASE_TEST_URL && process.env.SUPABASE_TEST_KEY) return;
  let status: Record<string, string>;
  try {
    status = JSON.parse(execSync('npx supabase status -o json', { encoding: 'utf8' })) as Record<
      string,
      string
    >;
  } catch {
    throw new Error('Local Supabase is not running. Start it with `npx supabase start`.');
  }
  const url = status.API_URL;
  const key = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  if (!url || !key) throw new Error('Could not read the local Supabase URL and publishable key.');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
    throw new Error(`Refusing to run database tests against a non-local URL: ${url}`);
  }
  process.env.SUPABASE_TEST_URL = url;
  process.env.SUPABASE_TEST_KEY = key;
}
