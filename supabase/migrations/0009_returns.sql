-- FloorGuard Ops — Run 8 returns + returned material disposition
-- Migration 0009: returns, return_items, return_dispositions,
-- returned_remnants, return_exceptions, RET/REM central numbering,
-- atomic disposition RPCs with server-side role enforcement, RLS.
--
-- BALANCE RULE (spec section 11): a scanned return NEVER changes trusted
-- inventory. Only the return_restock RPC — supervisor-approved, version-
-- checked, fully atomic — may increase a roll balance. Every other path
-- (remnant, quarantine, scrap, vendor) creates separate records or events.

-- ============ central numbering: RET + REM ============
alter table public.business_number_counters
  drop constraint business_number_counters_kind_check;
alter table public.business_number_counters
  add constraint business_number_counters_kind_check
  check (kind in ('ORD','SO','WO','RCV','LOAD','RET','REM'));
insert into public.business_number_counters (kind, prefix, next_val) values
  ('RET', 'RET-', 100001),
  ('REM', 'REM-', 100001)
on conflict (kind) do nothing;

-- ============ returns ============
create table public.returns (
  id             text primary key,
  return_number  text not null unique,
  warehouse_id   text not null references public.warehouses(id),
  work_order_id  text references public.work_orders(id),
  sales_order_id text references public.sales_orders(id),
  loadout_id     text references public.loadouts(id),
  property       text,
  account        text,
  source_kind    text not null default 'MANUAL'
                 check (source_kind in
                   ('WORK_ORDER','SALES_ORDER','LOADOUT','ROLL','MANUAL')),
  reason         text not null
                 check (reason in
                   ('JOB_CANCELLED','EXCESS_MATERIAL','WRONG_MATERIAL',
                    'WRONG_QUANTITY','DAMAGED','INSTALLATION_ISSUE',
                    'CUSTOMER_RETURN','UNUSED_MATERIAL','OTHER')),
  status         text not null default 'PENDING'
                 check (status in
                   ('PENDING','RECEIVED','INSPECTION','READY_FOR_DISPOSITION',
                    'COMPLETED','EXCEPTION','CANCELLED')),
  notes          text,
  created_by     text,
  received_by    text,
  client_request_key text unique,
  created_at     timestamptz not null default now(),
  received_at    timestamptz,
  completed_at   timestamptz,
  updated_at     timestamptz not null default now()
);
create index returns_warehouse_idx on public.returns (warehouse_id, status);
create index returns_number_idx on public.returns (return_number);

-- ============ return_items ============
create table public.return_items (
  id              text primary key,
  return_id       text not null references public.returns(id),
  warehouse_id    text not null references public.warehouses(id),
  material_type   text not null default 'CARPET',
  product_id      text references public.products(id),
  roll_id         text references public.rolls(id),
  source_inventory_assignment_id text references public.inventory_assignments(id),
  source_loadout_line_id text references public.loadout_lines(id),
  style           text,
  color           text,
  width_in        integer,
  uom             text not null default 'IN',
  returned_quantity integer,
  measured_in     integer,  -- RETURNED MEASURED BALANCE (integer inches)
  measured_by     text,
  measured_at     timestamptz,
  condition       text check (condition in
                    ('NEW_UNUSED','GOOD','OPENED','CUT_REMNANT','DAMAGED',
                     'WET_CONTAMINATED','UNKNOWN')),
  disposition     text check (disposition in
                    ('RESTOCK','QUARANTINE','SCRAP','RETURN_TO_VENDOR',
                     'HOLD_FOR_REVIEW')),
  status          text not null default 'PENDING'
                  check (status in
                    ('PENDING','MEASURED','INSPECTED','DISPOSITION_DECIDED',
                     'DISPOSITION_COMPLETE','EXCEPTION','CANCELLED')),
  location_code   text,
  notes           text,
  client_request_key text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index return_items_return_idx on public.return_items (return_id);
create index return_items_roll_idx on public.return_items (roll_id);

-- ============ return_dispositions (append-only audit of every decision) ============
create table public.return_dispositions (
  id                 text primary key,
  return_id          text not null references public.returns(id),
  return_item_id     text not null references public.return_items(id),
  warehouse_id       text not null references public.warehouses(id),
  disposition        text not null check (disposition in
                       ('RESTOCK','QUARANTINE','SCRAP','RETURN_TO_VENDOR',
                        'HOLD_FOR_REVIEW')),
  decided_by         text not null,
  approved_by        text,
  reason             text,
  location_code      text,
  previous_balance_in integer,
  quantity_in        integer,
  new_balance_in     integer,
  vendor_supplier    text,
  vendor_reference   text,
  vendor_status      text check (vendor_status in
                       ('PENDING_VENDOR_RETURN','SENT_TO_VENDOR','CLOSED')),
  client_request_key text unique,
  created_at         timestamptz not null default now()
);
create index return_dispositions_item_idx
  on public.return_dispositions (return_item_id);

-- ============ returned_remnants ============
create table public.returned_remnants (
  id              text primary key,
  remnant_number  text not null unique,
  parent_roll_id  text references public.rolls(id),
  return_id       text not null references public.returns(id),
  return_item_id  text not null references public.return_items(id),
  warehouse_id    text not null references public.warehouses(id),
  material_type   text not null default 'CARPET',
  style           text,
  color           text,
  width_in        integer,
  length_in       integer not null check (length_in > 0),
  condition       text,
  location_code   text,
  status          text not null default 'AVAILABLE'
                  check (status in
                    ('AVAILABLE','QUARANTINED','SCRAPPED','VENDOR_RETURN','HOLD')),
  created_by      text,
  client_request_key text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index returned_remnants_warehouse_idx
  on public.returned_remnants (warehouse_id, status);
create index returned_remnants_number_idx
  on public.returned_remnants (remnant_number);

-- ============ return_exceptions ============
create table public.return_exceptions (
  id             text primary key,
  return_id      text not null references public.returns(id),
  return_item_id text references public.return_items(id),
  warehouse_id   text not null references public.warehouses(id),
  kind           text not null check (kind in
                   ('UNKNOWN_MATERIAL','UNKNOWN_SOURCE','QUANTITY_MISMATCH',
                    'DAMAGED','DUPLICATE_RETURN','ROLL_MISMATCH',
                    'INVALID_LOCATION','CONDITION_ISSUE','OTHER')),
  detail         text,
  status         text not null default 'OPEN'
                 check (status in ('OPEN','RESOLVED','DISMISSED')),
  raised_by      text,
  resolved_by    text,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index return_exceptions_warehouse_idx
  on public.return_exceptions (warehouse_id, status);

-- ============ roll history event types for returns ============
alter table public.history_events
  drop constraint history_events_event_type_check;
alter table public.history_events
  add constraint history_events_event_type_check
  check (event_type in (
    'ROLL_DISCOVERED','INVENTORY_ASSIGNED','INVENTORY_RELEASED',
    'CUT','BALANCE_UPDATED','PHYSICAL_MEASUREMENT','CYCLE_COUNT',
    'LOCATION_OBSERVED','LOCATION_CHANGED','HISTORY_CARD_CAPTURED',
    'DOCUMENT_IMPORTED','DISCREPANCY','SUPERVISOR_REVIEW',
    'ASSIGNMENT_CONSUMED',
    'MATERIAL_RETURNED','RETURN_MEASURED','RETURN_INSPECTED',
    'RETURN_RESTOCK_APPROVED','BALANCE_INCREASED_FROM_RETURN',
    'RETURN_REMNANT_CREATED','RETURN_QUARANTINED','RETURN_SCRAPPED',
    'RETURN_SENT_TO_VENDOR','RETURN_LOCATION_ASSIGNED'));

-- ============ return documents (RETURN_CONDITION / RETURN_PAPERWORK / RETURN_LABEL) ============
alter table public.documents
  add column return_id text references public.returns(id) on delete cascade;
create index documents_return_idx on public.documents (return_id);
alter table public.documents drop constraint documents_owner_check;
alter table public.documents add constraint documents_owner_check
  check ((roll_id is not null)::int + (receipt_id is not null)::int + (return_id is not null)::int = 1);

-- ============ RLS ============
alter table public.returns            enable row level security;
alter table public.return_items       enable row level security;
alter table public.return_dispositions enable row level security;
alter table public.returned_remnants  enable row level security;
alter table public.return_exceptions  enable row level security;

-- Warehouse members read their warehouse's returns; managers read all.
create policy returns_select on public.returns for select to authenticated
  using (public.in_warehouse(warehouse_id));
create policy return_items_select on public.return_items for select to authenticated
  using (public.in_warehouse(warehouse_id));
create policy return_dispositions_select on public.return_dispositions for select to authenticated
  using (public.in_warehouse(warehouse_id));
create policy returned_remnants_select on public.returned_remnants for select to authenticated
  using (public.in_warehouse(warehouse_id));
create policy return_exceptions_select on public.return_exceptions for select to authenticated
  using (public.in_warehouse(warehouse_id));

-- Writes go through the RPCs below (SECURITY DEFINER, role-checked).
-- Direct INSERT is allowed only for return creation inputs that the RPCs
-- themselves do not own: none. All mutations are RPC-gated, so no
-- INSERT/UPDATE/DELETE policies are granted to app roles.
-- return_dispositions and return_exceptions are append-only by design.

-- ============ RPC helpers ============
create or replace function public.return_caller()
returns public.users language sql stable security definer
set search_path = public as $$
  select u.* from public.users u
  where u.auth_user_id = auth.uid() and u.active limit 1;
$$;

create or replace function public.return_fail(p_code text, p_message text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', p_code, 'message', p_message));
$$;

-- ============ create_return ============
-- Any active warehouse user. Issues the authoritative RET- number
-- server-side; the browser never invents one. Idempotent on
-- p_request_key: a retry returns the already-created return.
create or replace function public.create_return(
  p_id text, p_warehouse_id text,
  p_work_order_id text default null, p_sales_order_id text default null,
  p_loadout_id text default null, p_property text default null,
  p_account text default null, p_source_kind text default 'MANUAL',
  p_reason text default 'OTHER', p_notes text default null,
  p_employee text default null, p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_existing public.returns; v_num jsonb; v_ret public.returns;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.in_warehouse(p_warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if p_request_key is not null then
    select * into v_existing from public.returns where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'return_id', v_existing.id, 'return_number', v_existing.return_number);
    end if;
  end if;
  if p_reason = 'OTHER' and (p_notes is null or btrim(p_notes) = '') then
    return public.return_fail('NOTES_REQUIRED', 'Reason OTHER requires notes.');
  end if;
  v_num := public.issue_business_number('RET', 'RET:' || coalesce(p_request_key, p_id));
  if not (v_num->>'ok')::boolean then
    return public.return_fail('NUMBER_FAILED', 'Could not issue a return number.');
  end if;
  insert into public.returns
    (id, return_number, warehouse_id, work_order_id, sales_order_id,
     loadout_id, property, account, source_kind, reason, status, notes,
     created_by, client_request_key)
  values
    (p_id, v_num->>'number', p_warehouse_id, p_work_order_id, p_sales_order_id,
     p_loadout_id, p_property, p_account, p_source_kind, p_reason, 'PENDING',
     p_notes, coalesce(p_employee, v_caller.id), p_request_key)
  on conflict (client_request_key) do nothing
  returning * into v_ret;
  if v_ret is null then
    -- A racing retry won the key; return the winner.
    select * into v_existing from public.returns where client_request_key = p_request_key;
    return jsonb_build_object('ok', true, 'duplicate', true,
      'return_id', v_existing.id, 'return_number', v_existing.return_number);
  end if;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), p_warehouse_id,
     'RETURN_CREATED', 'return', v_ret.id, coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', 'Return ' || v_ret.return_number || ' created'));
  return jsonb_build_object('ok', true, 'duplicate', false,
    'return_id', v_ret.id, 'return_number', v_ret.return_number);
exception when unique_violation then
  if p_request_key is not null then
    select * into v_existing from public.returns where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'return_id', v_existing.id, 'return_number', v_existing.return_number);
    end if;
  end if;
  raise;
end;
$$;

-- ============ receive_return ============
create or replace function public.receive_return(
  p_return_id text, p_employee text default null, p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_ret public.returns;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  select * into v_ret from public.returns where id = p_return_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return not found.'); end if;
  if not public.in_warehouse(v_ret.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if v_ret.status in ('COMPLETED','CANCELLED') then
    return public.return_fail('INVALID_STATUS', 'Return is ' || v_ret.status || '.');
  end if;
  if v_ret.status <> 'PENDING' then
    return jsonb_build_object('ok', true, 'duplicate', true,
      'return_id', v_ret.id, 'status', v_ret.status);
  end if;
  update public.returns
     set status = 'RECEIVED', received_by = coalesce(p_employee, v_caller.id),
         received_at = now(), updated_at = now()
   where id = p_return_id;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_ret.warehouse_id,
     'RETURN_RECEIVED', 'return', p_return_id, coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', 'Return ' || v_ret.return_number || ' received'));
  return jsonb_build_object('ok', true, 'duplicate', false,
    'return_id', p_return_id, 'status', 'RECEIVED');
end;
$$;

-- ============ add_return_item ============
create or replace function public.add_return_item(
  p_id text, p_return_id text, p_warehouse_id text,
  p_material_type text default 'CARPET', p_product_id text default null,
  p_roll_id text default null,
  p_source_inventory_assignment_id text default null,
  p_source_loadout_line_id text default null,
  p_style text default null, p_color text default null,
  p_width_in integer default null, p_uom text default 'IN',
  p_returned_quantity integer default null,
  p_notes text default null, p_employee text default null,
  p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_ret public.returns; v_existing public.return_items;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.in_warehouse(p_warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  select * into v_ret from public.returns where id = p_return_id;
  if not found then return public.return_fail('NOT_FOUND', 'Return not found.'); end if;
  if v_ret.warehouse_id <> p_warehouse_id then
    return public.return_fail('WAREHOUSE_MISMATCH', 'Item warehouse must match the return.');
  end if;
  if v_ret.status in ('COMPLETED','CANCELLED') then
    return public.return_fail('INVALID_STATUS', 'Return is ' || v_ret.status || '.');
  end if;
  if p_request_key is not null then
    select * into v_existing from public.return_items where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'return_item_id', v_existing.id);
    end if;
  end if;
  insert into public.return_items
    (id, return_id, warehouse_id, material_type, product_id, roll_id,
     source_inventory_assignment_id, source_loadout_line_id,
     style, color, width_in, uom, returned_quantity, notes, client_request_key)
  values
    (p_id, p_return_id, p_warehouse_id, p_material_type, p_product_id, p_roll_id,
     p_source_inventory_assignment_id, p_source_loadout_line_id,
     p_style, p_color, p_width_in, p_uom, p_returned_quantity, p_notes, p_request_key)
  on conflict (client_request_key) do nothing;
  return jsonb_build_object('ok', true, 'duplicate', false, 'return_item_id', p_id);
exception when unique_violation then
  if p_request_key is not null then
    select * into v_existing from public.return_items where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'return_item_id', v_existing.id);
    end if;
  end if;
  raise;
end;
$$;

-- ============ measure_return_item (MB stamp) ============
create or replace function public.measure_return_item(
  p_item_id text, p_measured_in integer,
  p_employee text default null, p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_item public.return_items;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  select * into v_item from public.return_items where id = p_item_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return item not found.'); end if;
  if not public.in_warehouse(v_item.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if p_measured_in is null or p_measured_in < 0 then
    return public.return_fail('INVALID_INPUT', 'Measured length must be a non-negative integer.');
  end if;
  update public.return_items
     set measured_in = p_measured_in, measured_by = coalesce(p_employee, v_caller.id),
         measured_at = now(),
         status = case when status = 'PENDING' then 'MEASURED' else status end,
         updated_at = now()
   where id = p_item_id;
  return jsonb_build_object('ok', true, 'duplicate', false,
    'return_item_id', p_item_id, 'measured_in', p_measured_in);
end;
$$;

-- ============ inspect_return_item ============
create or replace function public.inspect_return_item(
  p_item_id text, p_condition text,
  p_employee text default null, p_notes text default null,
  p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_item public.return_items;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  select * into v_item from public.return_items where id = p_item_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return item not found.'); end if;
  if not public.in_warehouse(v_item.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  update public.return_items
     set condition = p_condition,
         notes = coalesce(p_notes, notes),
         status = 'INSPECTED', updated_at = now()
   where id = p_item_id;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_item.warehouse_id,
     'RETURN_INSPECTED', 'return_item', p_item_id, coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', 'Condition recorded: ' || p_condition));
  return jsonb_build_object('ok', true, 'return_item_id', p_item_id,
    'condition', p_condition, 'status', 'INSPECTED');
end;
$$;

-- ============ submit_return ============
-- Employee+. Transitions PENDING/RECEIVED/INSPECTION -> READY_FOR_DISPOSITION
-- after verifying every item has been measured or inspected.
-- Idempotent: already-submitted returns return duplicate:true.
-- p_request_key is accepted for client retry correlation; the status check
-- itself provides the idempotency (a retry after success sees
-- READY_FOR_DISPOSITION and returns duplicate:true).
create or replace function public.submit_return(
  p_return_id text, p_employee text default null,
  p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_ret public.returns; v_count int; v_bad int;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  select * into v_ret from public.returns where id = p_return_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return not found.'); end if;
  if not public.in_warehouse(v_ret.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if v_ret.status = 'READY_FOR_DISPOSITION' then
    return jsonb_build_object('ok', true, 'return_id', p_return_id,
      'status', 'READY_FOR_DISPOSITION', 'duplicate', true);
  end if;
  if v_ret.status not in ('PENDING', 'RECEIVED', 'INSPECTION') then
    return public.return_fail('INVALID_STATUS',
      'Only pending, received, or in-inspection returns can be submitted.');
  end if;
  select count(*) into v_count from public.return_items where return_id = p_return_id;
  if v_count = 0 then
    return public.return_fail('NO_ITEMS', 'Add at least one returned item.');
  end if;
  select count(*) into v_bad from public.return_items
   where return_id = p_return_id and status not in ('INSPECTED', 'MEASURED');
  if v_bad > 0 then
    return public.return_fail('ITEMS_NOT_INSPECTED', v_bad || ' item(s) still need inspection.');
  end if;
  update public.returns
     set status = 'READY_FOR_DISPOSITION', updated_at = now()
   where id = p_return_id;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_ret.warehouse_id,
     'RETURN_SUBMITTED', 'return', p_return_id, coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', v_count || ' item(s) submitted for disposition.'));
  return jsonb_build_object('ok', true, 'return_id', p_return_id,
    'status', 'READY_FOR_DISPOSITION', 'duplicate', false);
end;
$$;

-- ============ return_restock (THE atomic balance change) ============
-- Supervisor+. All-or-nothing:
--  1-6.  validate return, item, roll, condition, disposition, authorization
--  7.    verify roll version (optimistic concurrency)
--  8-9.  update roll balance + bump version
--  10.   record the disposition (append-only)
--  11.   roll history events (never silently altered)
--  12.   WO activity via history_events.work_order_id
--  13.   audit event
--  14.   mark the return item disposition-complete
create or replace function public.return_restock(
  p_item_id text, p_roll_id text, p_roll_version integer,
  p_location_code text, p_employee text, p_approver text default null,
  p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_item public.return_items; v_ret public.returns;
  v_roll public.rolls; v_existing public.return_dispositions;
  v_qty integer; v_prev integer; v_new integer;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  -- 6. authorization: supervisor or above. UI hiding is not enforcement.
  if not public.is_supervisor_or_above() then
    return public.return_fail('NOT_AUTHORIZED',
      'Restock approval requires a Supervisor or above.');
  end if;
  -- idempotency first: a retried approval returns the original outcome.
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id,
        'new_balance_in', v_existing.new_balance_in);
    end if;
  end if;
  -- 1. validate return + 2. validate item
  select * into v_item from public.return_items where id = p_item_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return item not found.'); end if;
  select * into v_ret from public.returns where id = v_item.return_id;
  if v_ret.status in ('COMPLETED','CANCELLED') then
    return public.return_fail('INVALID_STATUS', 'Return is ' || v_ret.status || '.');
  end if;
  if v_item.status = 'DISPOSITION_COMPLETE' then
    return public.return_fail('ALREADY_DISPOSITIONED',
      'This item already has a completed disposition.');
  end if;
  if not public.in_warehouse(v_item.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  -- 3. validate roll
  select * into v_roll from public.rolls where id = p_roll_id for update;
  if not found then return public.return_fail('ROLL_NOT_FOUND', 'Roll not found.'); end if;
  if v_roll.warehouse_id <> v_item.warehouse_id and not public.is_manager() then
    return public.return_fail('WAREHOUSE_MISMATCH', 'Roll is in a different warehouse.');
  end if;
  -- 4. condition must be restock-acceptable: damaged / wet / unknown material
  --    may never merge back into a trusted roll balance.
  if v_item.condition is null or v_item.condition not in
     ('NEW_UNUSED','GOOD','OPENED','CUT_REMNANT') then
    return public.return_fail('CONDITION_NOT_RESTOCKABLE',
      'Condition ' || coalesce(v_item.condition, 'UNKNOWN') ||
      ' cannot be restocked to an existing roll. Use Create Remnant, Quarantine, or Scrap.');
  end if;
  -- 5. disposition is RESTOCK by definition here
  -- 7. optimistic concurrency: reject stale reads, never overwrite newer data
  if p_roll_version is not null and v_roll.version <> p_roll_version then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'ROLL_VERSION_CONFLICT',
      'message', 'ROLL UPDATED BY ANOTHER DEVICE',
      'previous_balance_in', v_roll.expected_in,
      'current_version', v_roll.version));
  end if;
  v_qty := coalesce(v_item.measured_in, v_item.returned_quantity);
  if v_qty is null or v_qty <= 0 then
    return public.return_fail('INVALID_INPUT',
      'A measured or returned quantity is required before restock.');
  end if;
  -- 8-9. the ONLY balance write in this run: atomic with the version bump
  v_prev := v_roll.expected_in;
  v_new := v_prev + v_qty;
  update public.rolls
     set expected_in = v_new, version = version + 1,
         location_code = coalesce(p_location_code, location_code),
         updated_at = now()
   where id = p_roll_id;
  -- 10. disposition record (append-only)
  insert into public.return_dispositions
    (id, return_id, return_item_id, warehouse_id, disposition,
     decided_by, approved_by, reason, location_code,
     previous_balance_in, quantity_in, new_balance_in, client_request_key)
  values
    ('RD' || substring(md5(random()::text), 1, 12),
     v_item.return_id, p_item_id, v_item.warehouse_id, 'RESTOCK',
     coalesce(p_employee, v_caller.id), coalesce(p_approver, v_caller.id),
     'Restock approved', p_location_code, v_prev, v_qty, v_new, p_request_key)
  on conflict (client_request_key) do nothing;
  -- 11. roll history (ledger) — never silently altered
  insert into public.history_events
    (id, roll_id, warehouse_id, event_type, employee_name, work_order_id, detail, at)
  values
    ('H' || substring(md5(random()::text), 1, 12), p_roll_id, v_item.warehouse_id,
     'RETURN_RESTOCK_APPROVED', coalesce(p_approver, v_caller.id), v_ret.work_order_id,
     'Restock approved: +' || v_qty || ' in from return ' || v_ret.return_number, now()),
    ('H' || substring(md5(random()::text), 1, 12), p_roll_id, v_item.warehouse_id,
     'BALANCE_INCREASED_FROM_RETURN', coalesce(p_employee, v_caller.id), v_ret.work_order_id,
     v_prev || ' in -> ' || v_new || ' in (return ' || v_ret.return_number || ')', now());
  -- location assignment event when a location was scanned
  if p_location_code is not null then
    insert into public.history_events
      (id, roll_id, warehouse_id, event_type, employee_name, work_order_id, detail, at)
    values
      ('H' || substring(md5(random()::text), 1, 12), p_roll_id, v_item.warehouse_id,
       'RETURN_LOCATION_ASSIGNED', coalesce(p_employee, v_caller.id), v_ret.work_order_id,
       'Restock location: ' || p_location_code, now());
  end if;
  -- 13. audit
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_item.warehouse_id,
     'RETURN_RESTOCKED', 'return_item', p_item_id, coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', 'Restocked ' || v_qty || ' in to roll ' || p_roll_id ||
       ' (' || v_prev || ' -> ' || v_new || ' in)'));
  -- 14. mark the item complete
  update public.return_items
     set disposition = 'RESTOCK', status = 'DISPOSITION_COMPLETE',
         location_code = coalesce(p_location_code, location_code),
         updated_at = now()
   where id = p_item_id;
  return jsonb_build_object('ok', true, 'duplicate', false,
    'previous_balance_in', v_prev, 'quantity_in', v_qty,
    'new_balance_in', v_new, 'new_version', v_roll.version + 1);
exception when unique_violation then
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id,
        'new_balance_in', v_existing.new_balance_in);
    end if;
  end if;
  raise;
end;
$$;

-- ============ create_returned_remnant ============
-- Supervisor+. The returned carpet is a PHYSICALLY SEPARATE remnant: it gets
-- its own REM- number and its own inventory record. It is never merged back
-- into the parent roll's balance. Traceability: remnant -> return -> parent.
create or replace function public.create_returned_remnant(
  p_item_id text, p_length_in integer, p_location_code text default null,
  p_employee text default null, p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_item public.return_items; v_ret public.returns;
  v_existing public.return_dispositions; v_num jsonb; v_rem_id text;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.is_supervisor_or_above() then
    return public.return_fail('NOT_AUTHORIZED',
      'Remnant creation requires a Supervisor or above.');
  end if;
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id);
    end if;
  end if;
  select * into v_item from public.return_items where id = p_item_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return item not found.'); end if;
  select * into v_ret from public.returns where id = v_item.return_id;
  if v_ret.status in ('COMPLETED','CANCELLED') then
    return public.return_fail('INVALID_STATUS', 'Return is ' || v_ret.status || '.');
  end if;
  if v_item.status = 'DISPOSITION_COMPLETE' then
    return public.return_fail('ALREADY_DISPOSITIONED',
      'This item already has a completed disposition.');
  end if;
  if not public.in_warehouse(v_item.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if p_length_in is null or p_length_in <= 0 then
    return public.return_fail('INVALID_INPUT', 'Remnant length must be positive.');
  end if;
  v_num := public.issue_business_number('REM', 'REM:' || coalesce(p_request_key, p_item_id));
  if not (v_num->>'ok')::boolean then
    return public.return_fail('NUMBER_FAILED', 'Could not issue a remnant number.');
  end if;
  v_rem_id := 'REM' || substring(md5(random()::text), 1, 12);
  insert into public.returned_remnants
    (id, remnant_number, parent_roll_id, return_id, return_item_id,
     warehouse_id, material_type, style, color, width_in, length_in,
     condition, location_code, status, created_by, client_request_key)
  values
    (v_rem_id, v_num->>'number', v_item.roll_id, v_item.return_id, p_item_id,
     v_item.warehouse_id, v_item.material_type, v_item.style, v_item.color,
     v_item.width_in, p_length_in,
     v_item.condition, p_location_code, 'AVAILABLE',
     coalesce(p_employee, v_caller.id), p_request_key)
  on conflict (client_request_key) do nothing;
  insert into public.return_dispositions
    (id, return_id, return_item_id, warehouse_id, disposition,
     decided_by, approved_by, reason, location_code, quantity_in, client_request_key)
  values
    ('RD' || substring(md5(random()::text), 1, 12),
     v_item.return_id, p_item_id, v_item.warehouse_id, 'RESTOCK',
     coalesce(p_employee, v_caller.id), coalesce(p_employee, v_caller.id),
     'Returned remnant ' || (v_num->>'number') || ' created', p_location_code,
     p_length_in, p_request_key)
  on conflict (client_request_key) do nothing;
  -- parent roll history keeps the lineage visible
  if v_item.roll_id is not null then
    insert into public.history_events
      (id, roll_id, warehouse_id, event_type, employee_name, work_order_id, detail, at)
    values
      ('H' || substring(md5(random()::text), 1, 12), v_item.roll_id,
       v_item.warehouse_id, 'RETURN_REMNANT_CREATED',
       coalesce(p_employee, v_caller.id), v_ret.work_order_id,
       'Returned remnant ' || (v_num->>'number') || ' (' || p_length_in ||
       ' in) created from return ' || v_ret.return_number, now());
  end if;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_item.warehouse_id,
     'RETURN_REMNANT_CREATED', 'returned_remnant', v_rem_id,
     coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', 'Remnant ' || (v_num->>'number') || ' (' || p_length_in || ' in)'));
  update public.return_items
     set disposition = 'RESTOCK', status = 'DISPOSITION_COMPLETE',
         location_code = coalesce(p_location_code, location_code),
         updated_at = now()
   where id = p_item_id;
  return jsonb_build_object('ok', true, 'duplicate', false,
    'remnant_id', v_rem_id, 'remnant_number', v_num->>'number',
    'length_in', p_length_in);
exception when unique_violation then
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id);
    end if;
  end if;
  raise;
end;
$$;

-- ============ quarantine_return_item ============
-- Supervisor+. The material is tracked (location + reason) but is NOT
-- available for work-order assignment until a supervisor releases it.
create or replace function public.quarantine_return_item(
  p_item_id text, p_reason text, p_location_code text default null,
  p_employee text default null, p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_item public.return_items; v_ret public.returns;
  v_existing public.return_dispositions; v_rem_id text;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.is_supervisor_or_above() then
    return public.return_fail('NOT_AUTHORIZED',
      'Quarantine requires a Supervisor or above.');
  end if;
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id);
    end if;
  end if;
  select * into v_item from public.return_items where id = p_item_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return item not found.'); end if;
  select * into v_ret from public.returns where id = v_item.return_id;
  if v_ret.status in ('COMPLETED','CANCELLED') then
    return public.return_fail('INVALID_STATUS', 'Return is ' || v_ret.status || '.');
  end if;
  if v_item.status = 'DISPOSITION_COMPLETE' then
    return public.return_fail('ALREADY_DISPOSITIONED',
      'This item already has a completed disposition.');
  end if;
  if not public.in_warehouse(v_item.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    return public.return_fail('REASON_REQUIRED', 'A quarantine reason is required.');
  end if;
  -- Track the quarantined material as its own holding record so it stays
  -- visible (and locatable) without ever becoming assignable.
  v_rem_id := 'REM' || substring(md5(random()::text), 1, 12);
  insert into public.returned_remnants
    (id, remnant_number, parent_roll_id, return_id, return_item_id,
     warehouse_id, material_type, style, color, width_in,
     length_in, condition, location_code, status, created_by, client_request_key)
  values
    (v_rem_id,
     'Q-' || substring(md5(random()::text), 1, 8),
     v_item.roll_id, v_item.return_id, p_item_id,
     v_item.warehouse_id, v_item.material_type, v_item.style, v_item.color,
     v_item.width_in,
     coalesce(v_item.measured_in, v_item.returned_quantity, 0),
     v_item.condition, p_location_code, 'QUARANTINED',
     coalesce(p_employee, v_caller.id), p_request_key)
  on conflict (client_request_key) do nothing;
  insert into public.return_dispositions
    (id, return_id, return_item_id, warehouse_id, disposition,
     decided_by, approved_by, reason, location_code,
     quantity_in, client_request_key)
  values
    ('RD' || substring(md5(random()::text), 1, 12),
     v_item.return_id, p_item_id, v_item.warehouse_id, 'QUARANTINE',
     coalesce(p_employee, v_caller.id), coalesce(p_employee, v_caller.id),
     p_reason, p_location_code,
     coalesce(v_item.measured_in, v_item.returned_quantity), p_request_key)
  on conflict (client_request_key) do nothing;
  if v_item.roll_id is not null then
    insert into public.history_events
      (id, roll_id, warehouse_id, event_type, employee_name, work_order_id, detail, at)
    values
      ('H' || substring(md5(random()::text), 1, 12), v_item.roll_id,
       v_item.warehouse_id, 'RETURN_QUARANTINED',
       coalesce(p_employee, v_caller.id), v_ret.work_order_id,
       'Quarantined: ' || p_reason, now());
  end if;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_item.warehouse_id,
     'RETURN_QUARANTINED', 'return_item', p_item_id, coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', p_reason));
  update public.return_items
     set disposition = 'QUARANTINE', status = 'DISPOSITION_COMPLETE',
         location_code = coalesce(p_location_code, location_code),
         updated_at = now()
   where id = p_item_id;
  return jsonb_build_object('ok', true, 'duplicate', false,
    'holding_id', v_rem_id, 'status', 'QUARANTINED');
exception when unique_violation then
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id);
    end if;
  end if;
  raise;
end;
$$;

-- ============ scrap_return_item ============
-- Manager+. Permanent RETURN_SCRAPPED event; source inventory and history
-- are never deleted. Scrapped material is never assignable.
create or replace function public.scrap_return_item(
  p_item_id text, p_reason text,
  p_employee text default null, p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_item public.return_items; v_ret public.returns;
  v_existing public.return_dispositions;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.is_manager() then
    return public.return_fail('NOT_AUTHORIZED',
      'Scrap authorization requires a Manager or Admin.');
  end if;
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id);
    end if;
  end if;
  select * into v_item from public.return_items where id = p_item_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return item not found.'); end if;
  select * into v_ret from public.returns where id = v_item.return_id;
  if v_ret.status in ('COMPLETED','CANCELLED') then
    return public.return_fail('INVALID_STATUS', 'Return is ' || v_ret.status || '.');
  end if;
  if v_item.status = 'DISPOSITION_COMPLETE' then
    return public.return_fail('ALREADY_DISPOSITIONED',
      'This item already has a completed disposition.');
  end if;
  if not public.in_warehouse(v_item.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    return public.return_fail('REASON_REQUIRED', 'A scrap reason is required.');
  end if;
  insert into public.return_dispositions
    (id, return_id, return_item_id, warehouse_id, disposition,
     decided_by, approved_by, reason,
     quantity_in, client_request_key)
  values
    ('RD' || substring(md5(random()::text), 1, 12),
     v_item.return_id, p_item_id, v_item.warehouse_id, 'SCRAP',
     coalesce(p_employee, v_caller.id), v_caller.id,
     p_reason, coalesce(v_item.measured_in, v_item.returned_quantity), p_request_key)
  on conflict (client_request_key) do nothing;
  if v_item.roll_id is not null then
    insert into public.history_events
      (id, roll_id, warehouse_id, event_type, employee_name, work_order_id, detail, at)
    values
      ('H' || substring(md5(random()::text), 1, 12), v_item.roll_id,
       v_item.warehouse_id, 'RETURN_SCRAPPED',
       coalesce(p_employee, v_caller.id), v_ret.work_order_id,
       'Scrapped: ' || p_reason, now());
  end if;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_item.warehouse_id,
     'RETURN_SCRAPPED', 'return_item', p_item_id, coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', p_reason));
  update public.return_items
     set disposition = 'SCRAP', status = 'DISPOSITION_COMPLETE', updated_at = now()
   where id = p_item_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'SCRAPPED');
exception when unique_violation then
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id);
    end if;
  end if;
  raise;
end;
$$;

-- ============ send_return_to_vendor ============
-- Manager+. Tracks the vendor return; no accounting/credits in this run.
create or replace function public.send_return_to_vendor(
  p_item_id text, p_supplier text, p_reference text default null,
  p_employee text default null, p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_item public.return_items; v_ret public.returns;
  v_existing public.return_dispositions;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.is_manager() then
    return public.return_fail('NOT_AUTHORIZED',
      'Vendor returns require a Manager or Admin.');
  end if;
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id);
    end if;
  end if;
  select * into v_item from public.return_items where id = p_item_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return item not found.'); end if;
  select * into v_ret from public.returns where id = v_item.return_id;
  if v_ret.status in ('COMPLETED','CANCELLED') then
    return public.return_fail('INVALID_STATUS', 'Return is ' || v_ret.status || '.');
  end if;
  if v_item.status = 'DISPOSITION_COMPLETE' then
    return public.return_fail('ALREADY_DISPOSITIONED',
      'This item already has a completed disposition.');
  end if;
  if not public.in_warehouse(v_item.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  insert into public.return_dispositions
    (id, return_id, return_item_id, warehouse_id, disposition,
     decided_by, approved_by, reason, vendor_supplier, vendor_reference,
     vendor_status, quantity_in, client_request_key)
  values
    ('RD' || substring(md5(random()::text), 1, 12),
     v_item.return_id, p_item_id, v_item.warehouse_id, 'RETURN_TO_VENDOR',
     coalesce(p_employee, v_caller.id), v_caller.id,
     'Vendor return', p_supplier, p_reference,
     'PENDING_VENDOR_RETURN',
     coalesce(v_item.measured_in, v_item.returned_quantity), p_request_key)
  on conflict (client_request_key) do nothing;
  if v_item.roll_id is not null then
    insert into public.history_events
      (id, roll_id, warehouse_id, event_type, employee_name, work_order_id, detail, at)
    values
      ('H' || substring(md5(random()::text), 1, 12), v_item.roll_id,
       v_item.warehouse_id, 'RETURN_SENT_TO_VENDOR',
       coalesce(p_employee, v_caller.id), v_ret.work_order_id,
       'Vendor return: ' || coalesce(p_supplier, 'unknown supplier'), now());
  end if;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_item.warehouse_id,
     'RETURN_SENT_TO_VENDOR', 'return_item', p_item_id,
     coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', coalesce(p_supplier, 'unknown supplier')));
  update public.return_items
     set disposition = 'RETURN_TO_VENDOR', status = 'DISPOSITION_COMPLETE',
         updated_at = now()
   where id = p_item_id;
  return jsonb_build_object('ok', true, 'duplicate', false,
    'vendor_status', 'PENDING_VENDOR_RETURN');
exception when unique_violation then
  if p_request_key is not null then
    select * into v_existing from public.return_dispositions
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
        'disposition_id', v_existing.id);
    end if;
  end if;
  raise;
end;
$$;

-- ============ hold_return_item (HOLD_FOR_REVIEW) ============
-- Supervisor+. Parks the item without changing any inventory.
create or replace function public.hold_return_item(
  p_item_id text, p_reason text default null,
  p_employee text default null, p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_item public.return_items;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.is_supervisor_or_above() then
    return public.return_fail('NOT_AUTHORIZED',
      'Hold for review requires a Supervisor or above.');
  end if;
  select * into v_item from public.return_items where id = p_item_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return item not found.'); end if;
  if not public.in_warehouse(v_item.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if v_item.status = 'DISPOSITION_COMPLETE' then
    return public.return_fail('ALREADY_DISPOSITIONED',
      'This item already has a completed disposition.');
  end if;
  update public.return_items
     set disposition = 'HOLD_FOR_REVIEW', status = 'DISPOSITION_DECIDED',
         notes = coalesce(p_reason, notes), updated_at = now()
   where id = p_item_id;
  return jsonb_build_object('ok', true, 'status', 'HOLD_FOR_REVIEW');
end;
$$;

-- ============ complete_return ============
-- Supervisor+. Guard: every item must be disposition-complete or cancelled.
create or replace function public.complete_return(
  p_return_id text, p_employee text default null, p_request_key text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_ret public.returns; v_open integer;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.is_supervisor_or_above() then
    return public.return_fail('NOT_AUTHORIZED',
      'Completing a return requires a Supervisor or above.');
  end if;
  select * into v_ret from public.returns where id = p_return_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return not found.'); end if;
  if not public.in_warehouse(v_ret.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if v_ret.status = 'COMPLETED' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', 'COMPLETED');
  end if;
  if v_ret.status = 'CANCELLED' then
    return public.return_fail('INVALID_STATUS', 'Return is CANCELLED.');
  end if;
  select count(*) into v_open from public.return_items
   where return_id = p_return_id
     and status not in ('DISPOSITION_COMPLETE','CANCELLED');
  if v_open > 0 then
    return public.return_fail('ITEMS_PENDING',
      v_open || ' item(s) still need a completed disposition.');
  end if;
  update public.returns
     set status = 'COMPLETED', completed_at = now(), updated_at = now()
   where id = p_return_id;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_ret.warehouse_id,
     'RETURN_COMPLETED', 'return', p_return_id,
     coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', 'Return ' || v_ret.return_number || ' completed'));
  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'COMPLETED');
end;
$$;

-- ============ cancel_return ============
-- Manager+. Never deletes: the return and its history stay auditable.
create or replace function public.cancel_return(
  p_return_id text, p_reason text default null, p_employee text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_ret public.returns;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.is_manager() then
    return public.return_fail('NOT_AUTHORIZED',
      'Cancelling a return requires a Manager or Admin.');
  end if;
  select * into v_ret from public.returns where id = p_return_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Return not found.'); end if;
  if not public.in_warehouse(v_ret.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  if v_ret.status = 'COMPLETED' then
    return public.return_fail('INVALID_STATUS', 'A completed return cannot be cancelled.');
  end if;
  update public.returns
     set status = 'CANCELLED',
         notes = coalesce(p_reason, notes), updated_at = now()
   where id = p_return_id;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_ret.warehouse_id,
     'RETURN_CANCELLED', 'return', p_return_id, coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', coalesce(p_reason, 'cancelled')));
  return jsonb_build_object('ok', true, 'status', 'CANCELLED');
end;
$$;

-- ============ return exceptions ============
create or replace function public.raise_return_exception(
  p_return_id text, p_kind text, p_detail text default null,
  p_item_id text default null, p_employee text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_ret public.returns; v_ex_id text;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  select * into v_ret from public.returns where id = p_return_id;
  if not found then return public.return_fail('NOT_FOUND', 'Return not found.'); end if;
  if not public.in_warehouse(v_ret.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  v_ex_id := 'RX' || substring(md5(random()::text), 1, 12);
  insert into public.return_exceptions
    (id, return_id, return_item_id, warehouse_id, kind, detail, status, raised_by)
  values
    (v_ex_id, p_return_id, p_item_id, v_ret.warehouse_id, p_kind, p_detail,
     'OPEN', coalesce(p_employee, v_caller.id));
  update public.returns set status = 'EXCEPTION', updated_at = now()
   where id = p_return_id and status not in ('COMPLETED','CANCELLED');
  return jsonb_build_object('ok', true, 'exception_id', v_ex_id);
end;
$$;

create or replace function public.resolve_return_exception(
  p_exception_id text, p_resolution text default null,
  p_employee text default null)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users; v_ex public.return_exceptions; v_open integer;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.is_supervisor_or_above() then
    return public.return_fail('NOT_AUTHORIZED',
      'Resolving exceptions requires a Supervisor or above.');
  end if;
  select * into v_ex from public.return_exceptions where id = p_exception_id for update;
  if not found then return public.return_fail('NOT_FOUND', 'Exception not found.'); end if;
  if not public.in_warehouse(v_ex.warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;
  update public.return_exceptions
     set status = 'RESOLVED', resolved_by = coalesce(p_employee, v_caller.id),
         resolved_at = now()
   where id = p_exception_id;
  -- If no open exceptions remain, lift the return out of EXCEPTION.
  select count(*) into v_open from public.return_exceptions
   where return_id = v_ex.return_id and status = 'OPEN';
  if v_open = 0 then
    update public.returns set status = 'INSPECTION', updated_at = now()
     where id = v_ex.return_id and status = 'EXCEPTION';
  end if;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), v_ex.warehouse_id,
     'RETURN_EXCEPTION_RESOLVED', 'return_exception', p_exception_id, coalesce(p_employee, v_caller.id),
     jsonb_build_object('detail', coalesce(p_resolution, 'resolved')));
  return jsonb_build_object('ok', true, 'status', 'RESOLVED');
end;
$$;

-- ============ RPC grants (app roles call RPCs, never tables directly) ============
grant execute on function public.create_return(text,text,text,text,text,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.receive_return(text,text,text) to authenticated;
grant execute on function public.add_return_item(text,text,text,text,text,text,text,text,text,text,integer,text,integer,text,text,text) to authenticated;
grant execute on function public.measure_return_item(text,integer,text,text) to authenticated;
grant execute on function public.inspect_return_item(text,text,text,text,text) to authenticated;
grant execute on function public.return_restock(text,text,integer,text,text,text,text) to authenticated;
grant execute on function public.create_returned_remnant(text,integer,text,text,text) to authenticated;
grant execute on function public.quarantine_return_item(text,text,text,text,text) to authenticated;
grant execute on function public.scrap_return_item(text,text,text,text) to authenticated;
grant execute on function public.send_return_to_vendor(text,text,text,text,text) to authenticated;
grant execute on function public.hold_return_item(text,text,text,text) to authenticated;
grant execute on function public.complete_return(text,text,text) to authenticated;
grant execute on function public.cancel_return(text,text,text) to authenticated;
grant execute on function public.raise_return_exception(text,text,text,text,text) to authenticated;
grant execute on function public.resolve_return_exception(text,text,text) to authenticated;
