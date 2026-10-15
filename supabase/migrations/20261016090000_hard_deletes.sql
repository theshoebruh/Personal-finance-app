-- Hard deletes with a deletions log (audit finding F-05).
--
-- Before: a delete set `deleted = true` and kept every column, so deleted descriptions, amounts and
-- dates stayed stored. After: a delete removes the row. Only a small entry in `deletions`
-- (table name, id, revision, timestamps; no financial content) remains, so other devices still
-- learn about the deletion when they sync.
--
-- Data change: rows already marked deleted are moved into `deletions` and removed. Rows that are
-- not deleted are not touched. The whole migration runs in one transaction.

-- ---------------------------------------------------------------------------------------------
-- 1. Deletions log
-- ---------------------------------------------------------------------------------------------
create table public.deletions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  table_name text not null check (
    table_name in (
      'accounts', 'categories', 'import_batches', 'transactions', 'budgets', 'goals',
      'goal_contributions', 'recurring_rules', 'import_profiles', 'categorisation_rules',
      'projects', 'invoices', 'settings'
    )
  ),
  id text not null check (char_length(id) between 1 and 64),
  revision bigint not null check (revision > 0),
  deleted_at timestamptz not null default now(),
  server_updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, table_name, id)
);

create index deletions_sync_idx on public.deletions (user_id, server_updated_at);

create or replace function public.tg_deletion_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.server_updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger deletions_touch
  before insert or update on public.deletions
  for each row execute function public.tg_deletion_touch();

alter table public.deletions enable row level security;
alter table public.deletions force row level security;
create policy "Owners can read their deletions" on public.deletions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Owners can add their deletions" on public.deletions
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Owners can change their deletions" on public.deletions
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Owners can delete their deletions" on public.deletions
  for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.deletions from public, anon;
grant select, insert, update, delete on public.deletions to authenticated;
alter publication supabase_realtime add table public.deletions;
revoke all on function public.tg_deletion_touch() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. A record re-created after a deletion continues from the deletion's revision, so devices that
--    saw the deletion can tell the new version is newer.
-- ---------------------------------------------------------------------------------------------
create or replace function public.tg_sync_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := coalesce(
      (select d.revision from public.deletions d
        where d.user_id = new.user_id and d.table_name = tg_table_name and d.id = new.id),
      0
    ) + 1;
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
-- 3. Move existing tombstones into the log and remove their content
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
    execute format(
      'insert into public.deletions (user_id, table_name, id, revision, deleted_at)
         select user_id, %L, id, revision, server_updated_at from public.%I where deleted
       on conflict (user_id, table_name, id) do update
         set revision = greatest(public.deletions.revision, excluded.revision)',
      t, t);
    execute format('delete from public.%I where deleted', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. sync_push: deletes remove the row and log the deletion; re-creating a deleted id requires
--    having seen the deletion (same optimistic-concurrency rule as edits).
--    Tombstones returned to the app are {id, revision, deleted: true, server_updated_at}.
-- ---------------------------------------------------------------------------------------------
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
    'projects', 'invoices', 'settings'
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

-- ---------------------------------------------------------------------------------------------
-- 5. sync_pull: deletions come from the log (content-free tombstones).
-- ---------------------------------------------------------------------------------------------
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
