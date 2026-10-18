import Dexie, { type Table } from 'dexie';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Session tokens live in IndexedDB rather than localStorage (requirements §7.1), in a small database
 * of their own so signing out or deleting a user's data never touches another user's session.
 */
class AuthStorageDb extends Dexie {
  kv!: Table<{ key: string; value: string }, string>;
  constructor() {
    super('personal-finance-hub-auth');
    this.version(1).stores({ kv: 'key' });
  }
}

let storageDb: AuthStorageDb | null = null;
const authDb = () => (storageDb ??= new AuthStorageDb());

export const indexedDbAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      return (await authDb().kv.get(key))?.value ?? null;
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    await authDb().kv.put({ key, value });
  },
  async removeItem(key: string): Promise<void> {
    await authDb().kv.delete(key);
  },
};

export function createSupabaseBrowserClient(url: string, publishableKey: string): SupabaseClient {
  return createClient(url, publishableKey, {
    auth: {
      storage: indexedDbAuthStorage,
      persistSession: true,
      autoRefreshToken: true,
      // Password-reset links come back with a code in the URL; PKCE keeps it single-use.
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  });
}
