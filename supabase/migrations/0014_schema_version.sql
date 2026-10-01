-- 0014_schema_version.sql
-- Run 9: backend schema-version mechanism. The app knows which migration
-- level it requires (FloorGuard Ops v0.9 requires schema >= 14); on
-- switching to Shared Pilot the app reads the newest applied version and
-- refuses unsafe operation with BACKEND UPDATE REQUIRED when behind.
create table if not exists public.schema_version_history (
  version    integer primary key,
  applied_at timestamptz not null default now()
);
-- Backfill: this migration can only run after 0001-0013, so record them all.
insert into public.schema_version_history (version)
select g from generate_series(1, 14) g
on conflict (version) do nothing;

alter table public.schema_version_history enable row level security;
drop policy if exists schema_version_read on public.schema_version_history;
create policy schema_version_read on public.schema_version_history
  for select to authenticated using (true);

grant select on public.schema_version_history to authenticated;
