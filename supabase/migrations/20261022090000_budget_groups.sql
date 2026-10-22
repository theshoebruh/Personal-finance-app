-- Custom budget groups (Needs, Wants, Savings, Buffer and any the user adds, e.g. "RF").
--
-- Additive only: a new table and one nullable column on categories. No existing row is changed or
-- removed. Categories without a group keep working: the app maps them by their existing "group"
-- value until it assigns one. Older app versions ignore the new table (unknown tables are skipped
-- when pulling) and the new column.

-- ---------------------------------------------------------------------------------------------
-- 1. Budget groups: one row per group per user, with its share of income.
-- ---------------------------------------------------------------------------------------------
create table public.budget_groups (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null check (char_length(name) between 1 and 40),
  -- "spending" groups hold categories; the one "leftover" group (Buffer) is income minus spending.
  kind text not null check (kind in ('spending', 'leftover')),
  colour integer not null check (colour between 0 and 6),
  target_percent numeric(5, 2) not null check (target_percent between 0 and 100),
  sort_order integer not null check (sort_order between 0 and 1000),
  is_demo boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision bigint not null default 1,
  server_updated_at timestamptz not null default clock_timestamp(),
  deleted boolean not null default false,
  primary key (user_id, id)
);

-- Same protections and sync wiring as every other table.
alter table public.budget_groups enable row level security;
alter table public.budget_groups force row level security;
create policy "Owners can read their rows" on public.budget_groups
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Owners can add their rows" on public.budget_groups
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Owners can change their rows" on public.budget_groups
  for update to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
create policy "Owners can delete their rows" on public.budget_groups
  for delete to authenticated using (user_id = (select auth.uid()));
create trigger budget_groups_sync_row before insert or update on public.budget_groups
  for each row execute function public.tg_sync_row();
create index budget_groups_sync_idx on public.budget_groups (user_id, server_updated_at);
revoke all on public.budget_groups from public, anon;
grant select, insert, update, delete on public.budget_groups to authenticated;
alter publication supabase_realtime add table public.budget_groups;

-- ---------------------------------------------------------------------------------------------
-- 2. Which group a category belongs to (null = decided by its existing "group" value).
-- ---------------------------------------------------------------------------------------------
alter table public.categories
  add column budget_group_id text check (char_length(budget_group_id) between 1 and 64),
  add foreign key (user_id, budget_group_id)
    references public.budget_groups (user_id, id) deferrable initially deferred;

-- ---------------------------------------------------------------------------------------------
-- 3. Deletions log and sync functions learn about the new table.
-- ---------------------------------------------------------------------------------------------
alter table public.deletions drop constraint deletions_table_name_check;
alter table public.deletions add constraint deletions_table_name_check check (
  table_name in (
    'accounts', 'categories', 'import_batches', 'transactions', 'budgets', 'goals',
    'goal_contributions', 'recurring_rules', 'import_profiles', 'categorisation_rules',
    'projects', 'invoices', 'settings', 'budget_groups'
  )
);

-- sync_push and sync_pull: unchanged from 20261016090000_hard_deletes.sql except for the table lists.

create or replace function public.sync_push(p_changes jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_allowed constant text[] := array[
    'accounts', 'categories', 'import_batches', 'transactions', 'budgets', 'goals',
    'goal_contributions', 'recurring_rules', 'import_profiles', 'categorisation_rules',
    'projects', 'invoices', 'settings', 'budget_groups'
  ];
  v_set_lists jsonb := '{}'::jsonb;
  v_set text;
  v_change jsonb;
  v_table text;
  v_id text;
  v_op text;
  v_base bigint;
  v_record jsonb;
  v_existing jsonb;
  v_deletion public.deletions%rowtype;
  v_tomb jsonb;
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'Sign in to sync' using errcode = '28000';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'changes must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 500 then
    raise exception 'At most 500 changes per call' using errcode = '22023';
  end if;

  for v_change in select value from jsonb_array_elements(p_changes) loop
    v_table := v_change ->> 'table';
    v_id := v_change ->> 'id';
    v_op := v_change ->> 'op';
    v_base := nullif(v_change ->> 'base_rev', '')::bigint;

    if v_table is null or not (v_table = any (v_allowed)) then
      raise exception 'Unknown table: %', v_table using errcode = '22023';
    end if;
    if v_id is null or char_length(v_id) not between 1 and 64 then
      raise exception 'Invalid id' using errcode = '22023';
    end if;
    if v_op is null or v_op not in ('upsert', 'delete') then
      raise exception 'Invalid op: %', v_op using errcode = '22023';
    end if;

    execute format('select to_jsonb(t) from public.%I t where t.user_id = $1 and t.id = $2 for update', v_table)
      into v_existing
      using v_uid, v_id;

    v_tomb := null;
    if v_existing is null then
      select * into v_deletion from public.deletions d
       where d.user_id = v_uid and d.table_name = v_table and d.id = v_id
       for update;
      if found then
        v_tomb := jsonb_build_object(
          'id', v_id, 'revision', v_deletion.revision, 'deleted', true,
          'server_updated_at', v_deletion.server_updated_at);
      end if;
    end if;

    if v_op = 'delete' then
      if v_existing is null then
        -- Already deleted (or never existed): nothing to do.
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id, 'status', 'applied',
          'revision', (v_tomb ->> 'revision')::bigint, 'record', v_tomb));
      elsif (v_existing ->> 'revision')::bigint = v_base then
        execute format('delete from public.%I t where t.user_id = $1 and t.id = $2', v_table)
          using v_uid, v_id;
        insert into public.deletions (user_id, table_name, id, revision)
          values (v_uid, v_table, v_id, (v_existing ->> 'revision')::bigint + 1)
          on conflict (user_id, table_name, id) do update
            set revision = excluded.revision, deleted_at = now()
          returning * into v_deletion;
        v_tomb := jsonb_build_object(
          'id', v_id, 'revision', v_deletion.revision, 'deleted', true,
          'server_updated_at', v_deletion.server_updated_at);
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id, 'status', 'applied',
          'revision', v_deletion.revision, 'record', v_tomb));
      else
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id, 'status', 'conflict',
          'revision', (v_existing ->> 'revision')::bigint, 'record', v_existing));
      end if;
      continue;
    end if;

    -- upsert: the owner and sync columns always come from the server, never the client.
    v_record := coalesce(v_change -> 'record', '{}'::jsonb)
      - 'user_id' - 'id' - 'revision' - 'server_updated_at' - 'deleted'
      || jsonb_build_object('user_id', v_uid, 'id', v_id, 'deleted', false);

    if v_existing is null then
      if v_tomb is not null and v_base is distinct from (v_tomb ->> 'revision')::bigint then
        -- Deleted elsewhere since this device last saw it.
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id, 'status', 'conflict',
          'revision', (v_tomb ->> 'revision')::bigint, 'record', v_tomb));
        continue;
      end if;
      execute format(
        'insert into public.%I select * from jsonb_populate_record(null::public.%I, $1) returning to_jsonb(%I.*)',
        v_table, v_table, v_table)
        into v_row
        using v_record;
      if v_tomb is not null then
        delete from public.deletions d
         where d.user_id = v_uid and d.table_name = v_table and d.id = v_id;
      end if;
    elsif (v_existing ->> 'revision')::bigint = v_base then
      v_set := v_set_lists ->> v_table;
      if v_set is null then
        select string_agg(format('%I = r.%I', c.column_name, c.column_name), ', ' order by c.ordinal_position)
          into v_set
          from information_schema.columns c
         where c.table_schema = 'public'
           and c.table_name = v_table
           and c.column_name not in ('user_id', 'id', 'revision', 'server_updated_at');
        v_set_lists := v_set_lists || jsonb_build_object(v_table, v_set);
      end if;
      execute format(
        'update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where t.user_id = $2 and t.id = $3 returning to_jsonb(t)',
        v_table, v_set, v_table)
        into v_row
        using v_record, v_uid, v_id;
    else
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'table', v_table, 'id', v_id, 'status', 'conflict',
        'revision', (v_existing ->> 'revision')::bigint, 'record', v_existing));
      continue;
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'table', v_table, 'id', v_id, 'status', 'applied',
      'revision', (v_row ->> 'revision')::bigint, 'record', v_row));
  end loop;

  return v_results;
end;
$$;

create or replace function public.sync_pull(
  p_since timestamptz default '-infinity',
  p_since_table text default '',
  p_since_id text default '',
  p_limit integer default 500,
  p_rewind boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with cursor_pos as (
    select
      case when p_rewind then p_since - interval '60 seconds' else p_since end as ts,
      case when p_rewind then '' else coalesce(p_since_table, '') end as tbl,
      case when p_rewind then '' else coalesce(p_since_id, '') end as id
  ),
  changes as (
    select 'accounts'::text as tbl, t.id, t.server_updated_at as ts, to_jsonb(t) as rec
      from public.accounts t where t.user_id = (select auth.uid())
    union all select 'categories', t.id, t.server_updated_at, to_jsonb(t)
      from public.categories t where t.user_id = (select auth.uid())
    union all select 'import_batches', t.id, t.server_updated_at, to_jsonb(t)
      from public.import_batches t where t.user_id = (select auth.uid())
    union all select 'transactions', t.id, t.server_updated_at, to_jsonb(t)
      from public.transactions t where t.user_id = (select auth.uid())
    union all select 'budgets', t.id, t.server_updated_at, to_jsonb(t)
      from public.budgets t where t.user_id = (select auth.uid())
    union all select 'goals', t.id, t.server_updated_at, to_jsonb(t)
      from public.goals t where t.user_id = (select auth.uid())
    union all select 'goal_contributions', t.id, t.server_updated_at, to_jsonb(t)
      from public.goal_contributions t where t.user_id = (select auth.uid())
    union all select 'recurring_rules', t.id, t.server_updated_at, to_jsonb(t)
      from public.recurring_rules t where t.user_id = (select auth.uid())
    union all select 'import_profiles', t.id, t.server_updated_at, to_jsonb(t)
      from public.import_profiles t where t.user_id = (select auth.uid())
    union all select 'categorisation_rules', t.id, t.server_updated_at, to_jsonb(t)
      from public.categorisation_rules t where t.user_id = (select auth.uid())
    union all select 'projects', t.id, t.server_updated_at, to_jsonb(t)
      from public.projects t where t.user_id = (select auth.uid())
    union all select 'invoices', t.id, t.server_updated_at, to_jsonb(t)
      from public.invoices t where t.user_id = (select auth.uid())
    union all select 'settings', t.id, t.server_updated_at, to_jsonb(t)
      from public.settings t where t.user_id = (select auth.uid())
    union all select 'budget_groups', t.id, t.server_updated_at, to_jsonb(t)
      from public.budget_groups t where t.user_id = (select auth.uid())
    union all select d.table_name, d.id, d.server_updated_at,
        jsonb_build_object('id', d.id, 'revision', d.revision, 'deleted', true,
                           'server_updated_at', d.server_updated_at)
      from public.deletions d where d.user_id = (select auth.uid())
  ),
  page as (
    select c.*
      from changes c, cursor_pos p
     where (c.ts, c.tbl, c.id) > (p.ts, p.tbl, p.id)
     order by c.ts, c.tbl, c.id
     limit least(greatest(coalesce(p_limit, 500), 1), 1000)
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('table', tbl, 'record', rec) order by ts, tbl, id),
    '[]'::jsonb
  )
  from page;
$$;

revoke all on function public.sync_push(jsonb) from public, anon;
revoke all on function public.sync_pull(timestamptz, text, text, integer, boolean) from public, anon;
grant execute on function public.sync_push(jsonb) to authenticated;
grant execute on function public.sync_pull(timestamptz, text, text, integer, boolean) to authenticated;
