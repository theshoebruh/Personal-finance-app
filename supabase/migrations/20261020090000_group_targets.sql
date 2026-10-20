-- Target percentages for the five budget groups (Needs, Wants, Savings, RF/side business, Buffer).
-- Savings keeps using the existing savings_rate_percent column.
--
-- Additive only: four nullable columns on settings, no data changed. NULL means "use the app's
-- default" (Needs 50, Wants 20, RF 5, Buffer 5), so app versions that don't know these columns can
-- still sync settings (sync_push fills missing keys with NULL).

alter table public.settings
  add column needs_percent numeric(5, 2) check (needs_percent between 0 and 100),
  add column wants_percent numeric(5, 2) check (wants_percent between 0 and 100),
  add column side_business_percent numeric(5, 2) check (side_business_percent between 0 and 100),
  add column buffer_percent numeric(5, 2) check (buffer_percent between 0 and 100);
