-- Sync protocol used by the app. Both functions are SECURITY INVOKER: they run as the signed-in
-- user, so row-level security applies to every read and write they make.

-- ---------------------------------------------------------------------------------------------
-- sync_push(changes)
--   changes: [{ "table": text, "id": text, "op": "upsert" | "delete",
--               "base_rev": bigint | null, "record": { snake_case columns } }]
--   Returns: [{ "table", "id", "status": "applied" | "conflict", "revision", "record" }]
--
-- Optimistic concurrency: a write is applied only when the row is new, or when its current
-- revision equals base_rev (the revision this device last saw). Otherwise the change is reported
-- as a conflict together with the server's row, and nothing is overwritten.
-- Deletes become tombstones (deleted = true) so other devices learn about them.
-- All changes in one call commit together (deferred foreign keys and transfer checks run at commit).
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

    if v_op = 'delete' then
      if v_existing is null or (v_existing ->> 'deleted')::boolean then
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id, 'status', 'applied',
          'revision', (v_existing ->> 'revision')::bigint, 'record', v_existing));
      elsif (v_existing ->> 'revision')::bigint = v_base then
        execute format(
          'update public.%I t set deleted = true where t.user_id = $1 and t.id = $2 returning to_jsonb(t)', v_table)
          into v_row
          using v_uid, v_id;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'table', v_table, 'id', v_id, 'status', 'applied',
          'revision', (v_row ->> 'revision')::bigint, 'record', v_row));
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
      execute format(
        'insert into public.%I select * from jsonb_populate_record(null::public.%I, $1) returning to_jsonb(%I.*)',
        v_table, v_table, v_table)
        into v_row
        using v_record;
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
-- sync_pull(since, since_table, since_id, limit, rewind)
--   Rows of the signed-in user changed after the keyset cursor (server_updated_at, table, id),
--   tombstones included, oldest first. With rewind = true the cursor moves back 60 seconds to
--   catch writes that committed late; the app applies rows idempotently by revision.
--   Returns: [{ "table": text, "record": { ... } }]
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
