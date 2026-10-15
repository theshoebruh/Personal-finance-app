import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Database tests run against the local Supabase stack (`npx supabase start`), with real Auth,
 * PostgREST and row-level security. Run with `npm run test:db`.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['supabase/tests/**/*.test.ts'],
    globalSetup: ['./supabase/tests/globalSetup.ts'],
    setupFiles: ['fake-indexeddb/auto'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Tests create their own users, but run files one at a time to keep the local stack calm.
    fileParallelism: false,
  },
});
