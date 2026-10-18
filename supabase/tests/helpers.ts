import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

export const url = () => process.env.SUPABASE_TEST_URL!;
export const key = () => process.env.SUPABASE_TEST_KEY!;

export function anonClient(): SupabaseClient {
  return createClient(url(), key(), {
    auth: { persistSession: false, autoRefreshToken: false },
    // Node 20 has no global WebSocket; browsers do.
    realtime: { transport: WebSocket as never },
  });
}

export interface TestUser {
  client: SupabaseClient;
  id: string;
  email: string;
  password: string;
}

let n = 0;

/** Creates a fresh user through the public sign-up API (local stack: no email confirmation). */
export async function newUser(label = 'user'): Promise<TestUser> {
  const email = `${label}-${Date.now()}-${++n}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = 'Test-password-123';
  const client = anonClient();
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw error;
  if (!data.session || !data.user) throw new Error('Sign-up did not return a session');
  return { client, id: data.user.id, email, password };
}

const TS = '2026-03-01T08:00:00.000Z';

export function accountRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Account ${id}`,
    type: 'current',
    workspace: 'personal',
    institution: null,
    currency: 'ZAR',
    opening_balance_cents: 100_000,
    opening_balance_date: '2026-03-01',
    include_in_spendable: true,
    active: true,
    reconciled_balance_cents: null,
    reconciled_date: null,
    is_demo: false,
    created_at: TS,
    updated_at: TS,
    ...extra,
  };
}

export function txnRow(id: string, accountId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    account_id: accountId,
    date: '2026-03-05',
    description: `Txn ${id}`,
    amount_cents: -1_000,
    type: 'expense',
    category_id: null,
    workspace: 'personal',
    status: 'posted',
    source: 'manual',
    tags: [],
    archived: false,
    is_demo: false,
    created_at: TS,
    updated_at: TS,
    ...extra,
  };
}

export interface PushChange {
  table: string;
  id: string;
  op: 'upsert' | 'delete';
  base_rev: number | null;
  record?: Record<string, unknown>;
}

export interface PushResult {
  table: string;
  id: string;
  status: 'applied' | 'conflict';
  revision: number | null;
  record: Record<string, unknown> | null;
}

export async function push(client: SupabaseClient, changes: PushChange[]): Promise<PushResult[]> {
  const { data, error } = await client.rpc('sync_push', { p_changes: changes });
  if (error) throw error;
  return data as PushResult[];
}

export function upsert(
  table: string,
  record: Record<string, unknown> & { id: unknown },
  baseRev: number | null = null,
): PushChange {
  return { table, id: String(record.id), op: 'upsert', base_rev: baseRev, record };
}
