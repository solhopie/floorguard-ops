-- FloorGuard Ops — Run 7 loadout + receipts + central numbering
-- Migration 0008: authoritative backend-issued numbering for Orders,
-- Sales Orders, Work Orders, Receipts, and Loadouts, plus the loadout
-- and receipt tables with atomic, idempotent RPCs.
--
-- Design rules (spec §1, §6, §7, §13, §30, §31):
--   * Numbers are backend-issued, collision-safe across devices, and
--     immutable once issued. The browser never invents an ORD/SO/WO/RCV/
--     LOAD number in Shared Pilot mode.
--   * issue_business_number(kind, request_key) is idempotent: a retried
--     request with the same key returns the SAME number, never a new one.
--   * All multi-row mutations (start_loadout, create_receipt, receive_roll,
--     complete_loadout, complete_receipt) run in ONE transaction or nothing.
--   * Loading a line never changes a roll balance (rolls are only changed
--     by the record_cut RPC and receive_roll's initial balance).
--   * verify_loadout_line records a WRONG MATERIAL exception atomically
--     instead of raising — the wrong roll is never silently accepted.

-- ============ central numbering ============

create table public.business_number_counters (
  kind   text primary key check (kind in ('ORD','SO','WO','RCV','LOAD')),
  prefix text not null,
  next_val bigint not null check (next_val > 0)
);
insert into public.business_number_counters (kind, prefix, next_val) values
  ('ORD',  'ORD-',  100001),
  ('SO',   'SO-',   100001),
  ('WO',   'WO-',   200001),
  ('RCV',  'RCV-',  100001),
  ('LOAD', 'LOAD-', 100001)
on conflict (kind) do nothing;

-- Idempotency ledger: request_key -> issued number. A retry with the same
-- key returns the stored number instead of consuming a new one.
create table public.number_issues (
  request_key text primary key,
  kind        text not null,
  number      text not null,
  issued_at   timestamptz not null default now()
);

create or replace function public.issue_business_number(p_kind text, p_request_key text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  ctr record; issued text;
begin
  if p_request_key is not null then
    select kind, number into ctr from public.number_issues
     where request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'number', ctr.number);
    end if;
  end if;
  -- Row lock serializes concurrent issuers: no two transactions can take
  -- the same value, on any number of devices.
  select * into ctr from public.business_number_counters
   where kind = p_kind for update;
  if not found then
    raise exception 'UNKNOWN_NUMBER_KIND' using errcode = 'P0001';
  end if;
  issued := ctr.prefix || ctr.next_val::text;
  update public.business_number_counters
     set next_val = next_val + 1 where kind = p_kind;
  if p_request_key is not null then
    insert into public.number_issues (request_key, kind, number)
    values (p_request_key, p_kind, issued)
    on conflict (request_key) do nothing;
    -- A racing transaction won the key: return the winner's number.
    select number into issued from public.number_issues
     where request_key = p_request_key;
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'number', issued);
end;
$$;

-- Run 6 RPCs now issue numbers server-side when the client does not supply
-- one (Shared Pilot clients pass null; the number is keyed by the stable
-- sales-order / work-order id so retries stay idempotent).
create or replace function public.submit_sales_order(
  p_order_id text, p_sales_order_id text, p_number text, p_submitted_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  o record;
  so_id text; so_num text;
  now_ts timestamptz := now();
begin
  if not public.is_supervisor_or_above() then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if not public.in_warehouse(o.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  select id, number into so_id, so_num
    from public.sales_orders where source_order_id = o.id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true,
                              'sales_order_id', so_id, 'number', so_num);
  end if;
  if o.status not in ('DRAFT','READY_FOR_REVIEW') then
    raise exception 'INVALID_STATUS' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.order_items where order_id = o.id) then
    raise exception 'NO_ITEMS' using errcode = 'P0001';
  end if;

  if p_number is null then
    p_number := (public.issue_business_number('SO', 'so-num:' || p_sales_order_id)->>'number');
  end if;

  insert into public.sales_orders
    (id, number, source_order_id, warehouse_id, property, account, priority,
     requested_date, scheduled_date, status, created_by, submitted_by, notes,
     created_at, submitted_at, updated_at)
  values
    (p_sales_order_id, p_number, o.id, o.warehouse_id, o.property, o.account,
     o.priority, o.requested_date, o.scheduled_date, 'OPEN',
     o.created_by, p_submitted_by, o.notes, now_ts, now_ts, now_ts);

  insert into public.sales_order_lines
    (id, sales_order_id, seq, source_item_id, style, color, material_type, uom,
     width_in, ordered_in, ordered_qty, warehouse_qty_required, status, created_at)
  select 'SOL-' || substr(md5(oi.id || random()::text), 1, 12),
         p_sales_order_id, oi.seq, oi.id, oi.style, oi.color, oi.material_type, oi.uom,
         oi.width_in, oi.quantity_in, oi.quantity,
         coalesce(oi.quantity_in::numeric, oi.quantity),
         'OPEN', now_ts
    from public.order_items oi where oi.order_id = o.id order by oi.seq;

  update public.orders
     set status = 'SUBMITTED', submitted_at = now_ts, updated_at = now_ts,
         sales_order_id = p_sales_order_id
   where id = o.id;

  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), o.warehouse_id,
     'ORDER_SUBMITTED', 'sales_order', p_sales_order_id, p_submitted_by,
     jsonb_build_object('order_id', o.id, 'number', p_number), now_ts);

  return jsonb_build_object('ok', true, 'duplicate', false,
                            'sales_order_id', p_sales_order_id, 'number', p_number);
end;
$$;

create or replace function public.release_sales_order_line(
  p_line_id text, p_work_order_id text, p_wo_number text,
  p_style text, p_color text, p_material_type text, p_uom text,
  p_width_in integer, p_required_in integer, p_required_count numeric,
  p_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  ln record; so record; existing_wo_id text; now_ts timestamptz := now();
begin
  if not public.is_supervisor_or_above() then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  select * into ln from public.sales_order_lines where id = p_line_id for update;
  if not found then
    raise exception 'LINE_NOT_FOUND' using errcode = 'P0001';
  end if;
  select * into so from public.sales_orders where id = ln.sales_order_id;
  if not public.in_warehouse(so.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if so.on_hold or so.status = 'CANCELLED' then
    raise exception 'SALES_ORDER_NOT_RELEASABLE' using errcode = 'P0001';
  end if;

  if ln.status = 'RELEASED' then
    select id into existing_wo_id from public.work_orders
      where sales_order_line_id = ln.id;
    return jsonb_build_object('ok', true, 'duplicate', true,
                              'work_order_id', existing_wo_id);
  end if;

  if p_wo_number is null then
    p_wo_number := (public.issue_business_number('WO', 'wo-num:' || p_work_order_id)->>'number');
  end if;

  insert into public.work_orders
    (id, number, warehouse_id, property, account, status, assignment_status,
     scheduled_date, priority, sales_order_id, sales_order_line_id,
     notes, created_at)
  values
    (p_work_order_id, p_wo_number, so.warehouse_id, so.property, so.account,
     'OPEN', 'UNASSIGNED', so.scheduled_date, so.priority,
     so.id, ln.id,
     'Generated from ' || so.number || ' line ' || ln.seq || '.', now_ts)
  on conflict do nothing;

  select id into existing_wo_id from public.work_orders
    where sales_order_line_id = ln.id;
  insert into public.work_order_material_lines
    (id, work_order_id, style, color, material_type,
     width_in, required_in, required_count)
  values
    (p_work_order_id || '-L1', existing_wo_id,
     p_style, p_color, lower(p_material_type), p_width_in,
     coalesce(p_required_in, 0), p_required_count)
  on conflict (id) do nothing;

  update public.sales_order_lines
     set status = 'RELEASED', work_order_id = existing_wo_id
   where id = ln.id;
  update public.sales_orders
     set status = case when not exists (
                      select 1 from public.sales_order_lines l2
                       where l2.sales_order_id = so.id and l2.status <> 'RELEASED')
                    then 'RELEASED_TO_WAREHOUSE' else 'PARTIALLY_RELEASED' end,
         updated_at = now_ts
   where id = so.id;

  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id,
     related_work_order_id, user_name, new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), so.warehouse_id,
     'WORK_ORDER_GENERATED', 'sales_order', so.id,
     existing_wo_id, p_by,
     jsonb_build_object('line_id', ln.id, 'wo_number', p_wo_number), now_ts);

  return jsonb_build_object('ok', true, 'duplicate', false,
                            'work_order_id', existing_wo_id,
                            'wo_number', p_wo_number);
end;
$$;

-- ============ loadouts ============

create table public.loadouts (
  id            text primary key,
  number        text not null,
  work_order_id text references public.work_orders(id),
  sales_order_id text references public.sales_orders(id),
  warehouse_id  text not null references public.warehouses(id),
  property      text,
  account       text,
  status        text not null default 'READY'
                  check (status in ('READY','IN_PROGRESS','LOADED','COMPLETED','ON_HOLD')),
  priority      text not null default 'NORMAL'
                  check (priority in ('LOW','NORMAL','HIGH','URGENT')),
  started_by    text,
  started_at    timestamptz,
  completed_by  text,
  completed_at  timestamptz,
  on_hold       boolean not null default false,
  hold_reason   text,
  notes         text,
  client_request_key text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index loadouts_number_idx on public.loadouts (warehouse_id, number);
create unique index loadouts_request_key_uidx
  on public.loadouts (client_request_key) where client_request_key is not null;
-- One open loadout per work order (a retry returns the existing one).
create unique index loadouts_open_wo_uidx
  on public.loadouts (work_order_id)
  where work_order_id is not null and status in ('READY','IN_PROGRESS','LOADED');

create table public.loadout_lines (
  id            text primary key,
  loadout_id    text not null references public.loadouts(id) on delete cascade,
  seq           integer not null,
  style         text,
  color         text,
  material_type text,
  uom           text,
  width_in      integer,
  required_in   integer,
  required_count numeric,
  prepared_in   integer,
  roll_id       text references public.rolls(id),
  barcode       text,
  status        text not null default 'WAITING'
                  check (status in ('WAITING','VERIFIED','LOADED','EXCEPTION')),
  verified_by   text,
  verified_at   timestamptz,
  loaded_by     text,
  loaded_at     timestamptz,
  created_at    timestamptz not null default now()
);
create index loadout_lines_loadout_idx on public.loadout_lines (loadout_id);

create table public.loadout_exceptions (
  id          text primary key,
  loadout_id  text not null references public.loadouts(id) on delete cascade,
  line_id     text references public.loadout_lines(id) on delete set null,
  type        text not null
                check (type in ('MATERIAL MISSING','WRONG MATERIAL','DAMAGED MATERIAL',
                                'QUANTITY ISSUE','OTHER')),
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index loadout_exceptions_loadout_idx on public.loadout_exceptions (loadout_id);

-- ============ receipts ============

create table public.receipts (
  id               text primary key,
  number           text not null,
  warehouse_id     text not null references public.warehouses(id),
  supplier         text,
  reference_number text,
  status           text not null default 'EXPECTED'
                     check (status in ('EXPECTED','RECEIVING','RECEIVED','EXCEPTIONS')),
  expected_date    date,
  notes            text,
  created_by       text,
  created_at       timestamptz not null default now(),
  completed_by     text,
  completed_at     timestamptz,
  client_request_key text
);
create unique index receipts_number_idx on public.receipts (warehouse_id, number);
create unique index receipts_request_key_uidx
  on public.receipts (client_request_key) where client_request_key is not null;

create table public.receipt_lines (
  id               text primary key,
  receipt_id       text not null references public.receipts(id) on delete cascade,
  seq              integer not null,
  material_type    text,
  uom              text,
  style            text,
  color            text,
  manufacturer     text,
  width_in         integer,
  expected_qty_in  integer,
  expected_qty     numeric,
  received_qty_in  integer,
  received_qty     numeric,
  roll_id          text references public.rolls(id),
  barcode          text,
  location_code    text,
  status           text not null default 'EXPECTED'
                     check (status in ('EXPECTED','RECEIVED','EXCEPTION')),
  exception        text,
  received_by      text,
  received_at      timestamptz,
  client_request_key text,
  created_at       timestamptz not null default now()
);
create index receipt_lines_receipt_idx on public.receipt_lines (receipt_id);
create unique index receipt_lines_request_key_uidx
  on public.receipt_lines (client_request_key) where client_request_key is not null;

create table public.receipt_exceptions (
  id          text primary key,
  receipt_id  text not null references public.receipts(id) on delete cascade,
  line_id     text references public.receipt_lines(id) on delete set null,
  type        text not null
                check (type in ('SHORT RECEIPT','OVER RECEIPT','DAMAGED','UNKNOWN PRODUCT',
                                'DUPLICATE ROLL','WRONG LOCATION','OTHER')),
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index receipt_exceptions_receipt_idx on public.receipt_exceptions (receipt_id);

-- ============ RLS ============
alter table public.business_number_counters enable row level security;
alter table public.number_issues             enable row level security;
alter table public.loadouts                  enable row level security;
alter table public.loadout_lines             enable row level security;
alter table public.loadout_exceptions        enable row level security;
alter table public.receipts                  enable row level security;
alter table public.receipt_lines             enable row level security;
alter table public.receipt_exceptions        enable row level security;

-- Counters are read-only for everyone (issuance happens inside RPCs).
create policy counters_read on public.business_number_counters
  for select to authenticated using (true);
create policy number_issues_read on public.number_issues
  for select to authenticated using (true);

-- Warehouse members can read loadouts / receipts in their warehouse.
create policy loadouts_read on public.loadouts
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy loadout_lines_read on public.loadout_lines
  for select to authenticated
  using (exists (select 1 from public.loadouts l
                 where l.id = loadout_id and public.in_warehouse(l.warehouse_id)));
create policy loadout_exceptions_read on public.loadout_exceptions
  for select to authenticated
  using (exists (select 1 from public.loadouts l
                 where l.id = loadout_id and public.in_warehouse(l.warehouse_id)));
create policy receipts_read on public.receipts
  for select to authenticated using (public.in_warehouse(warehouse_id));
create policy receipt_lines_read on public.receipt_lines
  for select to authenticated
  using (exists (select 1 from public.receipts r
                 where r.id = receipt_id and public.in_warehouse(r.warehouse_id)));
create policy receipt_exceptions_read on public.receipt_exceptions
  for select to authenticated
  using (exists (select 1 from public.receipts r
                 where r.id = receipt_id and public.in_warehouse(r.warehouse_id)));

-- Direct writes are supervisor-gated; the normal warehouse-employee flows
-- run through the RPCs below, which re-check membership themselves.
create policy loadouts_write on public.loadouts
  for all to authenticated
  using (public.in_warehouse(warehouse_id) and public.is_supervisor_or_above())
  with check (public.in_warehouse(warehouse_id) and public.is_supervisor_or_above());
create policy loadout_lines_write on public.loadout_lines
  for all to authenticated
  using (exists (select 1 from public.loadouts l
                 where l.id = loadout_id
                   and public.in_warehouse(l.warehouse_id) and public.is_supervisor_or_above()))
  with check (exists (select 1 from public.loadouts l
                      where l.id = loadout_id
                        and public.in_warehouse(l.warehouse_id) and public.is_supervisor_or_above()));
create policy receipts_write on public.receipts
  for all to authenticated
  using (public.in_warehouse(warehouse_id) and public.is_supervisor_or_above())
  with check (public.in_warehouse(warehouse_id) and public.is_supervisor_or_above());
create policy receipt_lines_write on public.receipt_lines
  for all to authenticated
  using (exists (select 1 from public.receipts r
                 where r.id = receipt_id
                   and public.in_warehouse(r.warehouse_id) and public.is_supervisor_or_above()))
  with check (exists (select 1 from public.receipts r
                      where r.id = receipt_id
                        and public.in_warehouse(r.warehouse_id) and public.is_supervisor_or_above()));

-- ============ RPCs ============

-- Start a loadout for a work order. Atomic: number issuance + loadout +
-- lines + audit in one transaction. Idempotent on the client request key,
-- and on an already-open loadout for the same work order.
-- p_lines: jsonb array of {style,color,material_type,uom,width_in,
--   required_in,required_count,prepared_in,roll_id,barcode}.
create or replace function public.start_loadout(
  p_loadout_id text, p_request_key text, p_work_order_id text,
  p_by text, p_lines jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  w record; existing record; new_num text; now_ts timestamptz := now();
  ln jsonb; seq_i integer := 0;
begin
  select * into w from public.work_orders where id = p_work_order_id for update;
  if not found then
    raise exception 'WORK_ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if not public.in_warehouse(w.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;

  if p_request_key is not null then
    select id, number into existing from public.loadouts
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
                                'loadout_id', existing.id, 'number', existing.number);
    end if;
  end if;
  select id, number into existing from public.loadouts
   where work_order_id = p_work_order_id
     and status in ('READY','IN_PROGRESS','LOADED') limit 1;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true,
                              'loadout_id', existing.id, 'number', existing.number);
  end if;

  -- Authoritative readiness: every material line needs a CONSUMED assignment.
  if exists (
    select 1 from public.work_order_material_lines ml
     where ml.work_order_id = p_work_order_id
       and not exists (
         select 1 from public.inventory_assignments ia
          where ia.work_order_id = p_work_order_id
            and ia.line_id = ml.id
            and ia.status = 'CONSUMED')) then
    raise exception 'LOADOUT_NOT_READY' using errcode = 'P0001';
  end if;

  new_num := (public.issue_business_number('LOAD', 'load-num:' || p_loadout_id)->>'number');

  insert into public.loadouts
    (id, number, work_order_id, sales_order_id, warehouse_id, property, account,
     status, priority, started_by, started_at, client_request_key,
     created_at, updated_at)
  values
    (p_loadout_id, new_num, w.id, w.sales_order_id, w.warehouse_id,
     w.property, w.account, 'READY', coalesce(w.priority, 'NORMAL'),
     p_by, now_ts, p_request_key, now_ts, now_ts);

  for ln in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    seq_i := seq_i + 1;
    insert into public.loadout_lines
      (id, loadout_id, seq, style, color, material_type, uom, width_in,
       required_in, required_count, prepared_in, roll_id, barcode, status, created_at)
    values
      (p_loadout_id || '-L' || seq_i, p_loadout_id, seq_i,
       ln->>'style', ln->>'color', ln->>'material_type', ln->>'uom',
       nullif(ln->>'width_in', '')::integer,
       nullif(ln->>'required_in', '')::integer,
       nullif(ln->>'required_count', '')::numeric,
       nullif(ln->>'prepared_in', '')::integer,
       nullif(ln->>'roll_id', ''), nullif(ln->>'barcode', ''),
       'WAITING', now_ts);
  end loop;

  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id,
     related_work_order_id, user_name, new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), w.warehouse_id,
     'LOADOUT_STARTED', 'loadout', p_loadout_id,
     w.id, p_by,
     jsonb_build_object('number', new_num, 'lines', seq_i), now_ts);

  return jsonb_build_object('ok', true, 'duplicate', false,
                            'loadout_id', p_loadout_id, 'number', new_num);
end;
$$;

create or replace function public.begin_loadout_loading(p_loadout_id text, p_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  lo record; now_ts timestamptz := now();
begin
  select * into lo from public.loadouts where id = p_loadout_id for update;
  if not found then raise exception 'LOADOUT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.in_warehouse(lo.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if lo.status = 'IN_PROGRESS' then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if lo.status <> 'READY' then
    raise exception 'INVALID_STATUS' using errcode = 'P0001';
  end if;
  update public.loadouts set status = 'IN_PROGRESS', updated_at = now_ts
   where id = p_loadout_id;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id,
     related_work_order_id, user_name, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), lo.warehouse_id,
     'LOADOUT_LOADING_BEGUN', 'loadout', p_loadout_id,
     lo.work_order_id, p_by, now_ts);
  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

-- Verify a loadout line against a scanned barcode. A match verifies the
-- line; a mismatch records a WRONG MATERIAL exception atomically and
-- returns wrong_material:true — the wrong roll is never silently accepted.
create or replace function public.verify_loadout_line(
  p_loadout_id text, p_line_id text, p_barcode text, p_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  lo record; ln record; now_ts timestamptz := now();
begin
  select * into lo from public.loadouts where id = p_loadout_id;
  if not found then raise exception 'LOADOUT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.in_warehouse(lo.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if lo.status = 'COMPLETED' then
    raise exception 'LOADOUT_COMPLETED' using errcode = 'P0001';
  end if;
  select * into ln from public.loadout_lines
   where id = p_line_id and loadout_id = p_loadout_id for update;
  if not found then raise exception 'LINE_NOT_FOUND' using errcode = 'P0001'; end if;
  if ln.status = 'VERIFIED' then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if ln.status not in ('WAITING','EXCEPTION') then
    raise exception 'INVALID_STATUS' using errcode = 'P0001';
  end if;

  if upper(trim(p_barcode)) = upper(trim(coalesce(ln.barcode, ''))) and ln.barcode is not null then
    update public.loadout_lines
       set status = 'VERIFIED', verified_by = p_by, verified_at = now_ts
     where id = p_line_id;
    insert into public.audit_events
      (id, warehouse_id, action, entity_type, entity_id,
       related_work_order_id, user_name, new_value, created_at)
    values
      ('AE-' || substr(md5(random()::text), 1, 12), lo.warehouse_id,
       'LOADOUT_LINE_VERIFIED', 'loadout', p_loadout_id,
       lo.work_order_id, p_by,
       jsonb_build_object('line_id', p_line_id, 'barcode', p_barcode), now_ts);
    return jsonb_build_object('ok', true, 'duplicate', false);
  end if;

  insert into public.loadout_exceptions
    (id, loadout_id, line_id, type, notes, created_by, created_at)
  values
    ('LE-' || substr(md5(random()::text), 1, 12), p_loadout_id, p_line_id,
     'WRONG MATERIAL',
     'Scanned ' || p_barcode || ', expected ' || coalesce(ln.barcode, '—') || '.',
     p_by, now_ts);
  update public.loadout_lines set status = 'EXCEPTION' where id = p_line_id;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id,
     related_work_order_id, user_name, new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), lo.warehouse_id,
     'LOADOUT_EXCEPTION', 'loadout', p_loadout_id,
     lo.work_order_id, p_by,
     jsonb_build_object('line_id', p_line_id, 'type', 'WRONG MATERIAL'), now_ts);
  return jsonb_build_object('ok', true, 'wrong_material', true);
end;
$$;

-- Mark a verified line loaded. Loading never changes a roll balance.
create or replace function public.mark_loadout_line_loaded(
  p_loadout_id text, p_line_id text, p_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  lo record; ln record; now_ts timestamptz := now();
begin
  select * into lo from public.loadouts where id = p_loadout_id for update;
  if not found then raise exception 'LOADOUT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.in_warehouse(lo.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  select * into ln from public.loadout_lines
   where id = p_line_id and loadout_id = p_loadout_id for update;
  if not found then raise exception 'LINE_NOT_FOUND' using errcode = 'P0001'; end if;
  if ln.status = 'LOADED' then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if ln.status <> 'VERIFIED' then
    raise exception 'LINE_NOT_VERIFIED' using errcode = 'P0001';
  end if;
  update public.loadout_lines
     set status = 'LOADED', loaded_by = p_by, loaded_at = now_ts
   where id = p_line_id;
  if not exists (select 1 from public.loadout_lines
                  where loadout_id = p_loadout_id and status <> 'LOADED') then
    update public.loadouts set status = 'LOADED', updated_at = now_ts
     where id = p_loadout_id;
  elsif lo.status = 'READY' then
    update public.loadouts set status = 'IN_PROGRESS', updated_at = now_ts
     where id = p_loadout_id;
  end if;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id,
     related_work_order_id, user_name, new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), lo.warehouse_id,
     'LOADOUT_LINE_LOADED', 'loadout', p_loadout_id,
     lo.work_order_id, p_by,
     jsonb_build_object('line_id', p_line_id), now_ts);
  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

create or replace function public.create_loadout_exception(
  p_loadout_id text, p_line_id text, p_type text, p_notes text, p_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  lo record; now_ts timestamptz := now();
begin
  select * into lo from public.loadouts where id = p_loadout_id;
  if not found then raise exception 'LOADOUT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.in_warehouse(lo.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  insert into public.loadout_exceptions
    (id, loadout_id, line_id, type, notes, created_by, created_at)
  values
    ('LE-' || substr(md5(random()::text), 1, 12), p_loadout_id,
     nullif(p_line_id, ''), p_type, nullif(p_notes, ''), p_by, now_ts);
  if p_line_id is not null and p_line_id <> '' then
    update public.loadout_lines set status = 'EXCEPTION'
     where id = p_line_id and loadout_id = p_loadout_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Complete a loadout. Guard: every line must be LOADED. Atomic.
create or replace function public.complete_loadout(p_loadout_id text, p_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  lo record; pending integer; now_ts timestamptz := now();
begin
  select * into lo from public.loadouts where id = p_loadout_id for update;
  if not found then raise exception 'LOADOUT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.in_warehouse(lo.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if lo.status = 'COMPLETED' then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  select count(*) into pending from public.loadout_lines
   where loadout_id = p_loadout_id and status <> 'LOADED';
  if pending > 0 then
    raise exception 'LOADOUT_INCOMPLETE' using errcode = 'P0001';
  end if;
  update public.loadouts
     set status = 'COMPLETED', completed_by = p_by, completed_at = now_ts,
         updated_at = now_ts
   where id = p_loadout_id;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id,
     related_work_order_id, user_name, new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), lo.warehouse_id,
     'LOADOUT_COMPLETED', 'loadout', p_loadout_id,
     lo.work_order_id, p_by,
     jsonb_build_object('number', lo.number), now_ts);
  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

-- Create a receipt (expected or manual). Number is issued server-side,
-- idempotent on the client request key.
create or replace function public.create_receipt(
  p_receipt_id text, p_request_key text, p_supplier text, p_reference text,
  p_expected boolean, p_notes text, p_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  existing record; new_num text; now_ts timestamptz := now();
  wh_id text;
begin
  if p_request_key is not null then
    select id, number into existing from public.receipts
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
                                'receipt_id', existing.id, 'number', existing.number);
    end if;
  end if;
  -- Pilot warehouse: the caller's warehouse (mirrors other RPCs).
  wh_id := public.my_warehouse_id();
  if wh_id is null then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  new_num := (public.issue_business_number('RCV', 'rcv-num:' || p_receipt_id)->>'number');
  insert into public.receipts
    (id, number, warehouse_id, supplier, reference_number,
     status, notes, created_by, created_at, client_request_key)
  values
    (p_receipt_id, new_num, wh_id, nullif(p_supplier, ''), nullif(p_reference, ''),
     case when coalesce(p_expected, false) then 'EXPECTED' else 'RECEIVING' end,
     nullif(p_notes, ''), p_by, now_ts, p_request_key);
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name,
     new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), wh_id,
     'RECEIPT_CREATED', 'receipt', p_receipt_id, p_by,
     jsonb_build_object('number', new_num), now_ts);
  return jsonb_build_object('ok', true, 'duplicate', false,
                            'receipt_id', p_receipt_id, 'number', new_num);
end;
$$;

create or replace function public.add_receipt_line(
  p_receipt_id text, p_line_id text, p_request_key text,
  p_material_type text, p_uom text, p_style text, p_color text,
  p_expected_qty_in integer, p_expected_qty numeric, p_notes text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r record; existing record; seq_i integer; now_ts timestamptz := now();
begin
  select * into r from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'RECEIPT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.in_warehouse(r.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if r.status = 'RECEIVED' then
    raise exception 'RECEIPT_COMPLETED' using errcode = 'P0001';
  end if;
  if p_request_key is not null then
    select id into existing from public.receipt_lines
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'line_id', existing.id);
    end if;
  end if;
  select coalesce(max(seq), 0) + 1 into seq_i from public.receipt_lines
   where receipt_id = p_receipt_id;
  insert into public.receipt_lines
    (id, receipt_id, seq, material_type, uom, style, color,
     expected_qty_in, expected_qty, status, client_request_key, created_at)
  values
    (p_line_id, p_receipt_id, seq_i, p_material_type, p_uom,
     nullif(p_style, ''), nullif(p_color, ''),
     p_expected_qty_in, p_expected_qty, 'EXPECTED', p_request_key, now_ts);
  if r.status = 'EXPECTED' then
    update public.receipts set status = 'RECEIVING' where id = p_receipt_id;
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'line_id', p_line_id);
end;
$$;

-- Receive a carpet roll into a receipt. Atomic: the roll (with its initial
-- balance), the receipt line, and the audit row are created together.
-- An existing barcode returns ROLL_ALREADY_EXISTS (never a silent
-- duplicate); with p_override (supervisor) a DUPLICATE ROLL exception is
-- recorded against the existing roll instead, with no new roll and no
-- balance change.
create or replace function public.receive_roll(
  p_receipt_id text, p_line_id text, p_request_key text,
  p_barcode text, p_roll_id text,
  p_style text, p_color text, p_manufacturer text,
  p_width_in integer, p_length_in integer, p_location_code text,
  p_by text, p_override boolean)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r record; existing_line record; dup_roll record; seq_i integer;
  now_ts timestamptz := now();
begin
  select * into r from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'RECEIPT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.in_warehouse(r.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if r.status = 'RECEIVED' then
    raise exception 'RECEIPT_COMPLETED' using errcode = 'P0001';
  end if;
  if p_request_key is not null then
    select id, roll_id into existing_line from public.receipt_lines
     where client_request_key = p_request_key;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true,
                                'line_id', existing_line.id,
                                'roll_id', existing_line.roll_id);
    end if;
  end if;
  if p_length_in is null or p_length_in <= 0 then
    raise exception 'INVALID_QUANTITY' using errcode = 'P0001';
  end if;

  select id into dup_roll from public.rolls
   where upper(barcode) = upper(p_barcode) and warehouse_id = r.warehouse_id;
  if found then
    if not coalesce(p_override, false) then
      raise exception 'ROLL_ALREADY_EXISTS' using errcode = 'P0001';
    end if;
    if not public.is_supervisor_or_above() then
      raise exception 'FORBIDDEN' using errcode = 'P0001';
    end if;
    insert into public.receipt_exceptions
      (id, receipt_id, line_id, type, notes, created_by, created_at)
    values
      ('RE-' || substr(md5(random()::text), 1, 12), p_receipt_id, null,
       'DUPLICATE ROLL',
       'Barcode ' || p_barcode || ' already exists as roll ' || dup_roll.id ||
       '; acknowledged by supervisor, no new roll created, balance untouched.',
       p_by, now_ts);
    insert into public.audit_events
      (id, warehouse_id, action, entity_type, entity_id, user_name,
       new_value, created_at)
    values
      ('AE-' || substr(md5(random()::text), 1, 12), r.warehouse_id,
       'DUPLICATE_ROLL_ACKNOWLEDGED', 'receipt', p_receipt_id, p_by,
       jsonb_build_object('barcode', p_barcode, 'roll_id', dup_roll.id), now_ts);
    return jsonb_build_object('ok', true, 'duplicate_roll', true, 'roll_id', dup_roll.id);
  end if;

  insert into public.rolls
    (id, barcode, warehouse_id, manufacturer, style, color, material_type,
     width_in, beginning_in, expected_in, location_code, version, created_at)
  values
    (p_roll_id, p_barcode, r.warehouse_id, nullif(p_manufacturer, ''),
     nullif(p_style, ''), nullif(p_color, ''), 'carpet',
     p_width_in, p_length_in, p_length_in,
     nullif(p_location_code, ''), 1, now_ts);

  select coalesce(max(seq), 0) + 1 into seq_i from public.receipt_lines
   where receipt_id = p_receipt_id;
  insert into public.receipt_lines
    (id, receipt_id, seq, material_type, uom, style, color, manufacturer,
     width_in, received_qty_in, roll_id, barcode, location_code,
     status, received_by, received_at, client_request_key, created_at)
  values
    (p_line_id, p_receipt_id, seq_i, 'CARPET', 'LF',
     nullif(p_style, ''), nullif(p_color, ''), nullif(p_manufacturer, ''),
     p_width_in, p_length_in, p_roll_id, p_barcode, nullif(p_location_code, ''),
     'RECEIVED', p_by, now_ts, p_request_key, now_ts);

  if r.status = 'EXPECTED' then
    update public.receipts set status = 'RECEIVING' where id = p_receipt_id;
  end if;

  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name,
     new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), r.warehouse_id,
     'ROLL_RECEIVED', 'receipt', p_receipt_id, p_by,
     jsonb_build_object('roll_id', p_roll_id, 'barcode', p_barcode,
                        'length_in', p_length_in,
                        'location', p_location_code), now_ts);

  return jsonb_build_object('ok', true, 'duplicate', false,
                            'line_id', p_line_id, 'roll_id', p_roll_id);
end;
$$;

create or replace function public.create_receipt_exception(
  p_receipt_id text, p_line_id text, p_type text, p_notes text, p_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r record; now_ts timestamptz := now();
begin
  select * into r from public.receipts where id = p_receipt_id;
  if not found then raise exception 'RECEIPT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.in_warehouse(r.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  insert into public.receipt_exceptions
    (id, receipt_id, line_id, type, notes, created_by, created_at)
  values
    ('RE-' || substr(md5(random()::text), 1, 12), p_receipt_id,
     nullif(p_line_id, ''), p_type, nullif(p_notes, ''), p_by, now_ts);
  if p_line_id is not null and p_line_id <> '' then
    update public.receipt_lines
       set status = 'EXCEPTION', exception = p_type
     where id = p_line_id and receipt_id = p_receipt_id;
  end if;
  if r.status <> 'RECEIVED' then
    update public.receipts set status = 'EXCEPTIONS' where id = p_receipt_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Complete a receipt. Guard: at least one line. Atomic.
create or replace function public.complete_receipt(p_receipt_id text, p_by text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  r record; nlines integer; now_ts timestamptz := now();
begin
  select * into r from public.receipts where id = p_receipt_id for update;
  if not found then raise exception 'RECEIPT_NOT_FOUND' using errcode = 'P0001'; end if;
  if not public.in_warehouse(r.warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if r.status = 'RECEIVED' then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  select count(*) into nlines from public.receipt_lines where receipt_id = p_receipt_id;
  if nlines = 0 then
    raise exception 'RECEIPT_HAS_NO_LINES' using errcode = 'P0001';
  end if;
  update public.receipts
     set status = 'RECEIVED', completed_by = p_by, completed_at = now_ts
   where id = p_receipt_id;
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name,
     new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), r.warehouse_id,
     'RECEIPT_COMPLETED', 'receipt', p_receipt_id, p_by,
     jsonb_build_object('number', r.number, 'lines', nlines), now_ts);
  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

-- ============ atomic order creation (Run 7) ============
-- Backend-authoritative, idempotent order creation: the ORD number is issued
-- inside the same transaction that inserts the order, so a failed insert can
-- never burn a number and a retried create can never mint a duplicate order.
create or replace function public.create_order(
  p_order_id text, p_warehouse_id text, p_property text, p_account text,
  p_requested_date date, p_scheduled_date date, p_priority text,
  p_created_by text, p_internal_ref text, p_notes text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  now_ts timestamptz := now();
  o_num text;
begin
  if not public.in_warehouse(p_warehouse_id) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  select number into o_num from public.orders where id = p_order_id;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true,
                              'order_id', p_order_id, 'number', o_num);
  end if;
  o_num := (public.issue_business_number('ORD', 'ord-num:' || p_order_id)->>'number');
  insert into public.orders
    (id, number, warehouse_id, property, account, requested_date, scheduled_date,
     priority, created_by, internal_ref, notes, status, created_at, updated_at)
  values
    (p_order_id, o_num, p_warehouse_id, p_property, nullif(p_account, ''),
     p_requested_date, p_scheduled_date, coalesce(p_priority, 'NORMAL'),
     p_created_by, nullif(p_internal_ref, ''), nullif(p_notes, ''),
     'DRAFT', now_ts, now_ts);
  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name,
     new_value, created_at)
  values
    ('AE-' || substr(md5(random()::text), 1, 12), p_warehouse_id,
     'ORDER_CREATED', 'order', p_order_id, p_created_by,
     jsonb_build_object('number', o_num), now_ts);
  return jsonb_build_object('ok', true, 'duplicate', false,
                            'order_id', p_order_id, 'number', o_num);
end;
$$;

-- ============ Run 7 RPC grants ============
-- Document RPCs are callable by authenticated app users; warehouse membership
-- is re-checked inside each function. Direct number issuance is locked down:
-- every document number is minted inside its creating RPC (auditable), so
-- authenticated clients get no unrestricted counter access.
grant execute on function public.create_order(text,text,text,text,date,date,text,text,text,text) to authenticated;
grant execute on function public.start_loadout(text,text,text,text,jsonb) to authenticated;
grant execute on function public.begin_loadout_loading(text,text) to authenticated;
grant execute on function public.verify_loadout_line(text,text,text,text) to authenticated;
grant execute on function public.mark_loadout_line_loaded(text,text,text) to authenticated;
grant execute on function public.create_loadout_exception(text,text,text,text,text) to authenticated;
grant execute on function public.complete_loadout(text,text) to authenticated;
grant execute on function public.create_receipt(text,text,text,text,boolean,text,text) to authenticated;
grant execute on function public.add_receipt_line(text,text,text,text,text,text,text,integer,numeric,text) to authenticated;
grant execute on function public.receive_roll(text,text,text,text,text,text,text,text,integer,integer,text,text,boolean) to authenticated;
grant execute on function public.create_receipt_exception(text,text,text,text,text) to authenticated;
grant execute on function public.complete_receipt(text,text) to authenticated;
revoke execute on function public.create_order(text,text,text,text,date,date,text,text,text,text) from anon;
revoke execute on function public.start_loadout(text,text,text,text,jsonb) from anon;
revoke execute on function public.begin_loadout_loading(text,text) from anon;
revoke execute on function public.verify_loadout_line(text,text,text,text) from anon;
revoke execute on function public.mark_loadout_line_loaded(text,text,text) from anon;
revoke execute on function public.create_loadout_exception(text,text,text,text,text) from anon;
revoke execute on function public.complete_loadout(text,text) from anon;
revoke execute on function public.create_receipt(text,text,text,text,boolean,text,text) from anon;
revoke execute on function public.add_receipt_line(text,text,text,text,text,text,text,integer,numeric,text) from anon;
revoke execute on function public.receive_roll(text,text,text,text,text,text,text,text,integer,integer,text,text,boolean) from anon;
revoke execute on function public.create_receipt_exception(text,text,text,text,text) from anon;
revoke execute on function public.complete_receipt(text,text) from anon;
-- issue_business_number is an internal counter primitive: only the
-- security-definer RPCs above may call it. Revoked from PUBLIC (which covers
-- every login role); the document RPCs re-check warehouse membership.
revoke all on function public.issue_business_number(text,text) from public;

-- ============ receipt documents (Run 7) ============
-- Receiving documents (packing slips, paper cards) attach to receipts, not
-- rolls. The existing warehouse-scoped documents policies keep applying via
-- warehouse_id; a row carries exactly one of roll_id / receipt_id.
alter table public.documents
  alter column roll_id drop not null,
  add column receipt_id text references public.receipts(id) on delete cascade;
create index documents_receipt_idx on public.documents (receipt_id);
alter table public.documents add constraint documents_owner_check
  check ((roll_id is null) <> (receipt_id is null));
