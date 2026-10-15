import type { SupabaseClient } from '@supabase/supabase-js';
import { REMOTE_TABLES } from './rowMapping';

/**
 * Listens for changes to the signed-in user's rows so other devices' edits are pulled straight
 * away. Supabase Realtime only applies a row filter to table-specific subscriptions, so there is one
 * listener per synced table (a schema-wide listener with a filter receives nothing — audit F-01).
 * Row-level security still limits events to the user's own rows. The payload isn't used: any
 * event just triggers a normal pull. Returns a function that stops listening.
 */
export function subscribeToChanges(
  client: SupabaseClient,
  userId: string,
  onChange: () => void,
): () => void {
  let channel = client.channel(`sync-${userId}`);
  for (const table of Object.values(REMOTE_TABLES)) {
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` },
      () => onChange(),
    );
  }
  channel.subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}
