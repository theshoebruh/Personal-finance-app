/**
 * True for the build published as a Claude artifact (`npm run build:artifact`). That viewer runs the
 * app in a sandboxed frame: no file downloads, no service worker and no URL routing.
 */
export const IS_ARTIFACT = import.meta.env.MODE === 'artifact';

/**
 * Supabase project settings. Both values are public by design: the publishable (anon) key only
 * grants what row-level security allows a signed-in user. Never put a service-role/secret key here.
 */
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? '';
export const SUPABASE_PUBLISHABLE_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';

/** Sync (and sign-in) is on only when the project is configured; otherwise the app is local-only. */
export const SYNC_ENABLED = !IS_ARTIFACT && SUPABASE_URL !== '' && SUPABASE_PUBLISHABLE_KEY !== '';
