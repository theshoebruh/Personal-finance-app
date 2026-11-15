-- Group goals as fixed Rand amounts, as an alternative to % of income.
--
-- Additive only: two nullable columns, no data changed, no functions changed (sync_push and
-- sync_pull read a table's columns dynamically). NULL goal_mode means "percent" (today's
-- behaviour); NULL target_cents means no amount set yet (R0).

alter table public.settings
  add column goal_mode text check (goal_mode in ('percent', 'amount'));

alter table public.budget_groups
  add column target_cents bigint check (target_cents >= 0);
