-- Personal Finance Hub: synced copy of the app's local data model.
--
-- Every table mirrors a store in the app (src/domain/models). Rows are scoped to their owner by
-- user_id; row-level security is enabled and forced on every table. Sync columns:
--   revision           incremented on every write, for optimistic concurrency
--   server_updated_at  set on every write, used as the pull cursor
--   deleted            tombstone, so deletions reach other devices
-- Money is integer cents (bigint). Calendar dates are `date`. IDs are client-generated text.

-- ---------------------------------------------------------------------------------------------
-- Shared trigger: maintain sync columns and keep rows with their owner
-- ---------------------------------------------------------------------------------------------
create or replace function public.tg_sync_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
  else
    if new.user_id is distinct from old.user_id or new.id is distinct from old.id then
      raise exception 'A record cannot change owner or id' using errcode = '42501';
    end if;
    new.revision := old.revision + 1;
  end if;
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.accounts (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null check (char_length(name) between 1 and 80),
  type text not null check (type in ('current', 'savings', 'credit_card', 'cash', 'other')),
  workspace text not null check (workspace in ('personal', 'business')),
  institution text check (char_length(institution) <= 80),
  currency text not null check (currency = 'ZAR'),
  opening_balance_cents bigint not null,
  opening_balance_date date not null,
  include_in_spendable boolean not null,
  active boolean not null,
  reconciled_balance_cents bigint,
  reconciled_date date,
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id)
);

create table public.categories (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null check (char_length(name) between 1 and 60),
  kind text not null check (kind in ('income', 'expense')),
  "group" text not null check (
    "group" in ('essential', 'discretionary', 'savings', 'income', 'business_expense', 'business_income')
  ),
  workspace text not null check (workspace in ('personal', 'business', 'both')),
  archived boolean not null,
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id)
);

create table public.import_batches (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  account_id text not null,
  source text not null check (source in ('manual', 'csv', 'pdf', 'sms_text', 'notification', 'bank_integration')),
  file_name text check (char_length(file_name) <= 260),
  imported_at timestamptz not null,
  transaction_count integer not null check (transaction_count >= 0),
  error_count integer not null check (error_count >= 0),
  status text not null check (status in ('committed', 'undone')),
  skipped_count integer check (skipped_count >= 0),
  date_from date,
  date_to date,
  undone_at timestamptz,
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id),
  foreign key (user_id, account_id) references public.accounts (user_id, id) deferrable initially deferred
);

create table public.transactions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  account_id text not null,
  date date not null,
  posted_date date,
  description text not null check (char_length(description) between 1 and 200),
  original_description text check (char_length(original_description) <= 500),
  amount_cents bigint not null check (amount_cents <> 0),
  type text not null check (type in ('income', 'expense', 'transfer', 'refund', 'adjustment')),
  category_id text,
  workspace text not null check (workspace in ('personal', 'business')),
  status text not null check (status in ('pending', 'posted', 'needs_review', 'excluded')),
  source text not null check (source in ('manual', 'csv', 'pdf', 'sms_text', 'notification', 'bank_integration')),
  import_batch_id text,
  fingerprint text check (char_length(fingerprint) <= 200),
  transfer_id text,
  transfer_kind text check (transfer_kind in ('internal', 'owner_contribution', 'owner_draw')),
  recurring_rule_id text,
  recurring_occurrence_date date,
  invoice_id text,
  project_id text,
  notes text check (char_length(notes) <= 1000),
  tags jsonb not null default '[]' check (jsonb_typeof(tags) = 'array'),
  archived boolean not null,
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id),
  -- Same sign rules as the app: income and refunds are money in, expenses money out.
  constraint transactions_sign_matches_type check (
    (type <> 'income' or amount_cents > 0)
    and (type <> 'expense' or amount_cents < 0)
    and (type <> 'refund' or amount_cents > 0)
  ),
  -- Only transfers carry a transfer id, and every transfer leg has one.
  constraint transactions_transfer_id_matches_type check ((type = 'transfer') = (transfer_id is not null)),
  foreign key (user_id, account_id) references public.accounts (user_id, id) deferrable initially deferred,
  foreign key (user_id, category_id) references public.categories (user_id, id) deferrable initially deferred,
  foreign key (user_id, import_batch_id) references public.import_batches (user_id, id) deferrable initially deferred
);

create table public.budgets (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  category_id text not null,
  workspace text not null check (workspace in ('personal', 'business')),
  period text not null check (period = 'monthly'),
  limit_cents bigint not null check (limit_cents >= 0),
  active boolean not null,
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id),
  foreign key (user_id, category_id) references public.categories (user_id, id) deferrable initially deferred
);

create table public.goals (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null check (char_length(name) between 1 and 80),
  goal_type text not null check (
    goal_type in ('emergency_fund', 'monthly_buffer', 'personal_purchase', 'business_growth', 'other')
  ),
  workspace text not null check (workspace in ('personal', 'business')),
  target_mode text not null check (target_mode in ('fixed', 'emergency_auto')),
  target_cents bigint check (target_cents >= 0),
  target_date date,
  priority integer not null check (priority between 1 and 99),
  state text not null check (state in ('active', 'paused', 'completed', 'archived')),
  linked_account_id text,
  planned_monthly_cents bigint check (planned_monthly_cents >= 0),
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id),
  foreign key (user_id, linked_account_id) references public.accounts (user_id, id) deferrable initially deferred
);

create table public.goal_contributions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  goal_id text not null,
  date date not null,
  amount_cents bigint not null check (amount_cents <> 0),
  transaction_id text,
  note text check (char_length(note) <= 200),
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id),
  foreign key (user_id, goal_id) references public.goals (user_id, id) deferrable initially deferred
);

create table public.recurring_rules (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null check (char_length(name) between 1 and 80),
  direction text not null check (direction in ('income', 'expense')),
  amount_cents bigint not null check (amount_cents > 0),
  frequency text not null check (frequency in ('weekly', 'fortnightly', 'monthly', 'yearly', 'custom_days')),
  interval_days integer check (interval_days between 1 and 366),
  start_date date not null,
  end_date date,
  account_id text,
  category_id text,
  workspace text not null check (workspace in ('personal', 'business')),
  active boolean not null,
  settled_dates jsonb not null default '[]' check (jsonb_typeof(settled_dates) = 'array'),
  match_window_days integer not null check (match_window_days between 0 and 31),
  alert_lead_days integer not null check (alert_lead_days between 0 and 60),
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id),
  constraint recurring_rules_custom_interval check (frequency <> 'custom_days' or interval_days is not null),
  foreign key (user_id, account_id) references public.accounts (user_id, id) deferrable initially deferred,
  foreign key (user_id, category_id) references public.categories (user_id, id) deferrable initially deferred
);

create table public.import_profiles (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  account_id text not null,
  mapping jsonb not null check (jsonb_typeof(mapping) = 'object'),
  header_signature text check (char_length(header_signature) <= 2000),
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id),
  foreign key (user_id, account_id) references public.accounts (user_id, id) deferrable initially deferred
);

create table public.categorisation_rules (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null check (char_length(name) <= 80),
  match_text text not null check (char_length(match_text) <= 200),
  account_id text,
  direction text not null check (direction in ('in', 'out', 'any')),
  min_amount_cents bigint check (min_amount_cents >= 0),
  max_amount_cents bigint check (max_amount_cents >= 0),
  category_id text not null,
  origin text not null check (origin in ('user_rule', 'learned_mapping')),
  priority integer not null,
  enabled boolean not null,
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id),
  foreign key (user_id, account_id) references public.accounts (user_id, id) deferrable initially deferred,
  foreign key (user_id, category_id) references public.categories (user_id, id) deferrable initially deferred
);

create table public.projects (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null check (char_length(name) between 1 and 80),
  workspace text not null check (workspace in ('personal', 'business')),
  status text not null check (status in ('active', 'completed', 'archived')),
  budget_cents bigint check (budget_cents >= 0),
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id)
);

create table public.invoices (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  invoice_number text not null check (char_length(invoice_number) between 1 and 40),
  client text not null check (char_length(client) between 1 and 120),
  issue_date date not null,
  due_date date not null,
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null check (status in ('draft', 'sent', 'paid', 'void')),
  project_id text,
  paid_transaction_ids jsonb not null default '[]' check (jsonb_typeof(paid_transaction_ids) = 'array'),
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id),
  foreign key (user_id, project_id) references public.projects (user_id, id) deferrable initially deferred
);

create table public.settings (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (id = 'app'),
  locale text not null check (locale = 'en-ZA'),
  time_zone text not null check (time_zone = 'Africa/Johannesburg'),
  theme text not null check (theme = 'dark'),
  monthly_salary_cents bigint not null check (monthly_salary_cents >= 0),
  monthly_tithe_cents bigint not null check (monthly_tithe_cents >= 0),
  savings_rate_percent numeric(5, 2) not null check (savings_rate_percent between 0 and 100),
  payday_day_of_month integer check (payday_day_of_month between 1 and 31),
  next_payday_override date,
  budget_period_mode text not null check (budget_period_mode in ('calendar_month', 'pay_period')),
  strict_budget_cap boolean not null,
  reserve_planned_savings boolean not null,
  emergency_fund_months integer not null check (emergency_fund_months between 1 and 24),
  emergency_fund_fixed_target_cents bigint check (emergency_fund_fixed_target_cents >= 0),
  essential_monthly_override_cents bigint check (essential_monthly_override_cents >= 0),
  onboarding_complete boolean not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id)
);

-- Indexes for foreign keys and common lookups
create index transactions_account_idx on public.transactions (user_id, account_id);
create index transactions_category_idx on public.transactions (user_id, category_id);
create index transactions_import_batch_idx on public.transactions (user_id, import_batch_id);
create index transactions_transfer_idx on public.transactions (user_id, transfer_id) where transfer_id is not null;
create index import_batches_account_idx on public.import_batches (user_id, account_id);
create index budgets_category_idx on public.budgets (user_id, category_id);
create index goals_linked_account_idx on public.goals (user_id, linked_account_id);
create index goal_contributions_goal_idx on public.goal_contributions (user_id, goal_id);
create index recurring_rules_account_idx on public.recurring_rules (user_id, account_id);
create index recurring_rules_category_idx on public.recurring_rules (user_id, category_id);
create index import_profiles_account_idx on public.import_profiles (user_id, account_id);
create index categorisation_rules_account_idx on public.categorisation_rules (user_id, account_id);
create index categorisation_rules_category_idx on public.categorisation_rules (user_id, category_id);
create index invoices_project_idx on public.invoices (user_id, project_id);

-- ---------------------------------------------------------------------------------------------
-- Transfer integrity: at most two live legs per transfer, and a complete pair must balance.
-- Deferred to commit so both legs can arrive in one sync batch in any order.
-- ---------------------------------------------------------------------------------------------
create or replace function public.tg_check_transfer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
  v_sum bigint;
begin
  if new.transfer_id is null then
    return null;
  end if;
  select count(*), coalesce(sum(t.amount_cents), 0)
    into v_count, v_sum
    from public.transactions t
   where t.user_id = new.user_id
     and t.transfer_id = new.transfer_id
     and not t.deleted;
  if v_count > 2 then
    raise exception 'Transfer % has more than two legs', new.transfer_id using errcode = '23514';
  end if;
  if v_count = 2 and v_sum <> 0 then
    raise exception 'Transfer % legs do not balance', new.transfer_id using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger transactions_transfer_integrity
  after insert or update on public.transactions
  deferrable initially deferred
  for each row execute function public.tg_check_transfer();

-- ---------------------------------------------------------------------------------------------
-- Per-table setup: RLS, owner-only policies, sync trigger, pull index, privileges, realtime
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'accounts', 'categories', 'import_batches', 'transactions', 'budgets', 'goals',
    'goal_contributions', 'recurring_rules', 'import_profiles', 'categorisation_rules',
    'projects', 'invoices', 'settings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    execute format(
      'create policy "Owners can read their rows" on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    execute format(
      'create policy "Owners can add their rows" on public.%I for insert to authenticated with check (user_id = (select auth.uid()))', t);
    execute format(
      'create policy "Owners can change their rows" on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format(
      'create policy "Owners can delete their rows" on public.%I for delete to authenticated using (user_id = (select auth.uid()))', t);

    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.tg_sync_row()',
      t || '_sync_row', t);
    execute format('create index %I on public.%I (user_id, server_updated_at)', t || '_sync_idx', t);

    -- Least privilege: nothing for anonymous visitors; signed-in users only through RLS.
    execute format('revoke all on public.%I from public, anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);

    execute format('alter publication supabase_realtime add table public.%I', t);
  end loop;
end;
$$;

revoke all on function public.tg_sync_row() from public, anon, authenticated;
revoke all on function public.tg_check_transfer() from public, anon, authenticated;
