-- FloorGuard Ops — Run 4 shared backend
-- Migration 0004: Row Level Security + storage bucket.
--
-- SECURITY MODEL (architecture preparation, not a certification):
--   * RLS is enabled on every table; anon gets nothing.
--   * Role helpers are SECURITY DEFINER so policies never recurse into
--     the users table.
--   * Balance changes can ONLY happen inside the record_cut RPC:
--     direct UPDATE on rolls and direct INSERT on cut_transactions are
--     revoked from app roles. The RPC re-checks warehouse membership.
--   * Append-only tables (history_events, audit_events, cut_transactions,
--     cycle_count_records, documents) expose no UPDATE/DELETE policy.
--   * Assignment status transitions are enforced by trigger, not by trust.

-- ============ role helpers (SECURITY DEFINER, no RLS recursion) ============
create or replace function public.my_user_id()
returns text language sql stable security definer
set search_path = public as $$
  select id from public.users where auth_user_id = auth.uid() and active limit 1;
$$;

create or replace function public.my_warehouse_id()
returns text language sql stable security definer
set search_path = public as $$
  select warehouse_id from public.users where auth_user_id = auth.uid() and active limit 1;
$$;

create or replace function public.my_role()
returns text language sql stable security definer
set search_path = public as $$
  select role from public.users where auth_user_id = auth.uid() and active limit 1;
$$;

create or replace function public.is_manager()
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from public.users
    where auth_user_id = auth.uid() and active
      and role in ('MANAGER','ADMIN'));
$$;

create or replace function public.is_supervisor_or_above()
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from public.users
    where auth_user_id = auth.uid() and active
      and role in ('SUPERVISOR','MANAGER','ADMIN'));
$$;

create or replace function public.in_warehouse(p_warehouse_id text)
returns boolean language sql stable security definer
set search_path = public as $$
  select public.is_manager() or public.my_warehouse_id() = p_warehouse_id;
$$;

-- ============ enable RLS everywhere ============
alter table public.warehouses                  enable row level security;
alter table public.users                       enable row level security;
alter table public.products                    enable row level security;
alter table public.warehouse_locations         enable row level security;
alter table public.rolls                       enable row level security;
alter table public.work_orders                 enable row level security;
alter table public.work_order_material_lines   enable row level security;
alter table public.inventory_assignments       enable row level security;
alter table public.cut_transactions            enable row level security;
alter table public.cycle_count_sessions        enable row level security;
alter table public.cycle_count_records         enable row level security;
alter table public.discrepancies               enable row level security;
alter table public.history_events              enable row level security;
alter table public.documents                   enable row level security;
alter table public.history_card_imports        enable row level security;
alter table public.audit_events                enable row level security;

-- ============ warehouses / users ============
create policy warehouses_select on public.warehouses
  for select to authenticated using (true);
create policy warehouses_admin on public.warehouses
  for all to authenticated using (public.is_manager()) with check (public.is_manager());

create policy users_select on public.users
  for select to authenticated
  using (warehouse_id = public.my_warehouse_id() or public.is_manager() or id = public.my_user_id());
create policy users_manage on public.users
  for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- ============ catalog: products / locations / rolls ============
create policy products_rw on public.products
  for all to authenticated
  using (public.in_warehouse(warehouse_id)) with check (public.in_warehouse(warehouse_id));

create policy locations_rw on public.warehouse_locations
  for all to authenticated
  using (public.in_warehouse(warehouse_id)) with check (public.in_warehouse(warehouse_id));

-- Rolls: SELECT + INSERT for members (discovered rolls are created by
-- employees). NO direct UPDATE/DELETE policy: expected balances move only
-- through the record_cut RPC, which re-validates version + membership.
create policy rolls_read on public.rolls
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy rolls_insert on public.rolls
  for insert to authenticated with check (public.in_warehouse(warehouse_id));
revoke update, delete on public.rolls from authenticated, anon;

-- ============ work orders ============
create policy wo_read on public.work_orders
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy wo_insert on public.work_orders
  for insert to authenticated with check (public.in_warehouse(warehouse_id));
create policy wo_update on public.work_orders
  for update to authenticated
  using (public.in_warehouse(warehouse_id) and public.is_supervisor_or_above())
  with check (public.in_warehouse(warehouse_id));

create policy wo_lines_read on public.work_order_material_lines
  for select to authenticated
  using (exists (select 1 from public.work_orders w
                 where w.id = work_order_id and public.in_warehouse(w.warehouse_id)));
create policy wo_lines_insert on public.work_order_material_lines
  for insert to authenticated
  with check (exists (select 1 from public.work_orders w
                      where w.id = work_order_id and public.in_warehouse(w.warehouse_id)));
create policy wo_lines_update on public.work_order_material_lines
  for update to authenticated
  using (public.is_supervisor_or_above())
  with check (public.is_supervisor_or_above());

-- ============ assignments: state machine enforced by trigger ============
create or replace function public.check_assignment_transition()
returns trigger language plpgsql as $$
begin
  if old.status = new.status then return new; end if; -- metadata edits allowed
  if old.status = 'RESERVED' and new.status in ('RELEASED','CONSUMED') then return new; end if;
  raise exception 'Illegal assignment transition % -> %', old.status, new.status;
end $$;

drop trigger if exists assignments_transition on public.inventory_assignments;
create trigger assignments_transition
  before update on public.inventory_assignments
  for each row execute function public.check_assignment_transition();

create policy assign_read on public.inventory_assignments
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy assign_insert on public.inventory_assignments
  for insert to authenticated with check (public.in_warehouse(warehouse_id));
create policy assign_update on public.inventory_assignments
  for update to authenticated
  using (public.in_warehouse(warehouse_id)) with check (public.in_warehouse(warehouse_id));
-- no delete policy: assignments are append-only.

-- ============ cuts: RPC-only writes ============
create policy cuts_read on public.cut_transactions
  for select to authenticated using (public.in_warehouse(warehouse_id));
-- No INSERT/UPDATE/DELETE policy: cuts are written exclusively by the
-- record_cut RPC (idempotent, version-checked, atomic).
revoke insert, update, delete on public.cut_transactions from authenticated, anon;

-- ============ cycle counts ============
create policy cc_sess_rw on public.cycle_count_sessions
  for all to authenticated
  using (public.in_warehouse(warehouse_id)) with check (public.in_warehouse(warehouse_id));

create policy cc_rec_read on public.cycle_count_records
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy cc_rec_insert on public.cycle_count_records
  for insert to authenticated with check (public.in_warehouse(warehouse_id));
-- no update/delete: count records are immutable; recounts are new rows.

-- ============ discrepancies ============
create policy disc_read on public.discrepancies
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy disc_insert on public.discrepancies
  for insert to authenticated with check (public.in_warehouse(warehouse_id));
create policy disc_resolve on public.discrepancies
  for update to authenticated
  using (public.in_warehouse(warehouse_id) and public.is_supervisor_or_above())
  with check (public.in_warehouse(warehouse_id));

-- ============ history / documents / audit: append-only ============
create policy hist_read on public.history_events
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy hist_insert on public.history_events
  for insert to authenticated with check (public.in_warehouse(warehouse_id));
-- no update/delete: the ledger is append-only.

create policy docs_read on public.documents
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy docs_insert on public.documents
  for insert to authenticated with check (public.in_warehouse(warehouse_id));
-- no update/delete: a stored image is never overwritten.

create policy imports_read on public.history_card_imports
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy imports_insert on public.history_card_imports
  for insert to authenticated with check (public.in_warehouse(warehouse_id));
create policy imports_review on public.history_card_imports
  for update to authenticated
  using (public.in_warehouse(warehouse_id) and public.is_supervisor_or_above())
  with check (public.in_warehouse(warehouse_id));

create policy audit_read on public.audit_events
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy audit_insert on public.audit_events
  for insert to authenticated with check (public.in_warehouse(warehouse_id));
-- no update/delete: the audit trail is append-only.

-- ============ RPC grants ============
grant execute on function public.record_cut(text,text,integer,text,text,text,text,text,integer) to authenticated;
grant execute on function public.reserve_inventory(text,text,text,integer,text,text,text,text,integer,text,text) to authenticated;
revoke execute on function public.record_cut(text,text,integer,text,text,text,text,text,integer) from anon;
revoke execute on function public.reserve_inventory(text,text,text,integer,text,text,text,text,integer,text,text) from anon;

-- ============ history-card storage (private bucket) ============
insert into storage.buckets (id, name, public)
values ('history-cards', 'history-cards', false)
on conflict (id) do nothing;

-- Path convention: history-cards/<warehouse_id>/<roll_id>/<uuid>.jpg
-- Not publicly enumerable; readable only by members of that warehouse.
create policy "history-cards insert (own warehouse)"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'history-cards' and
    (storage.foldername(name))[1] = public.my_warehouse_id() or public.is_manager());

create policy "history-cards read (own warehouse)"
  on storage.objects for select to authenticated
  using (bucket_id = 'history-cards' and
    (storage.foldername(name))[1] = public.my_warehouse_id() or public.is_manager());
-- No update/delete policy: uploaded images are immutable.
