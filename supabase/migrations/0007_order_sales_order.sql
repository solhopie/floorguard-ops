-- FloorGuard Ops — Run 6 order + sales-order foundation
-- Migration 0007: commercial layer upstream of warehouse execution.
--
--   ORDER -> SALES ORDER -> WORK ORDER(S) -> ASSIGN INVENTORY -> ROLL -> CUT
--
-- Design rules (spec §2, §13, §30, §31):
--   * No pricing / accounting / payment fields. Unknown business rules stay
--     extensible — these tables model only the fields we understand.
--   * Order submission is atomic: the submit_sales_order RPC creates the
--     sales order + all its lines in ONE transaction, or nothing.
--   * Idempotency: sales_orders.source_order_id is UNIQUE (a retried submit
--     returns the existing sales order); work_orders.sales_order_line_id is
--     UNIQUE (a retried release returns the existing work order).
--   * Sales-order lines reference their source order item (source_item_id)
--     and carry the submitted values, so the frozen order stays the record.

-- ============ tables ============

create table public.orders (
  id            text primary key,
  number        text not null,
  warehouse_id  text not null references public.warehouses(id),
  property      text not null,
  account       text,
  requested_date date,
  scheduled_date date,
  priority      text not null default 'NORMAL'
                  check (priority in ('LOW','NORMAL','HIGH','URGENT')),
  created_by    text,
  internal_ref  text,
  notes         text,
  status        text not null default 'DRAFT'
                  check (status in ('DRAFT','READY_FOR_REVIEW','SUBMITTED','CANCELLED')),
  sales_order_id text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  submitted_at  timestamptz
);
create unique index orders_number_idx on public.orders (warehouse_id, number);

create table public.order_items (
  id            text primary key,
  order_id      text not null references public.orders(id) on delete cascade,
  seq           integer not null,
  style         text not null,
  color         text,
  material_type text not null check (material_type in ('CARPET','PLANK','PAD','OTHER')),
  uom           text not null check (uom in ('LF','BOX','EA','ROLL','SY')),
  width_in      integer,
  -- ORDER QUANTITY = requested material (never mixed with roll balances):
  -- carpet keeps integer inches; count-based materials keep a quantity.
  quantity_in   integer,
  quantity      numeric,
  notes         text,
  created_at    timestamptz not null default now(),
  check ((uom = 'LF' and quantity_in is not null and quantity_in > 0)
      or (uom <> 'LF' and quantity is not null and quantity > 0))
);

create table public.sales_orders (
  id              text primary key,
  number          text not null,
  source_order_id text not null unique references public.orders(id),
  warehouse_id    text not null references public.warehouses(id),
  property        text not null,
  account         text,
  priority        text not null default 'NORMAL'
                    check (priority in ('LOW','NORMAL','HIGH','URGENT')),
  requested_date  date,
  scheduled_date  date,
  status          text not null default 'OPEN'
                    check (status in ('OPEN','PARTIALLY_RELEASED','RELEASED_TO_WAREHOUSE',
                                      'IN_PROGRESS','COMPLETED','ON_HOLD','CANCELLED')),
  created_by      text,
  submitted_by    text,
  notes           text,
  on_hold         boolean not null default false,
  hold_reason     text,
  hold_at         timestamptz,
  hold_by         text,
  created_at      timestamptz not null default now(),
  submitted_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index sales_orders_number_idx on public.sales_orders (warehouse_id, number);

create table public.sales_order_lines (
  id              text primary key,
  sales_order_id  text not null references public.sales_orders(id) on delete cascade,
  seq             integer not null,
  source_item_id  text references public.order_items(id),
  style           text not null,
  color           text,
  material_type   text not null check (material_type in ('CARPET','PLANK','PAD','OTHER')),
  uom             text not null check (uom in ('LF','BOX','EA','ROLL','SY')),
  width_in        integer,
  ordered_in      integer,
  ordered_qty     numeric,
  warehouse_qty_required numeric,
  status          text not null default 'OPEN' check (status in ('OPEN','RELEASED')),
  work_order_id   text references public.work_orders(id),
  created_at      timestamptz not null default now()
);

-- Traceability: work order -> sales order -> sales order line (§20, §22).
-- required_count: count-based material quantity (BOX/EA/…) — the shared
-- schema is not architecturally limited to roll goods either.
alter table public.work_orders
  add column if not exists sales_order_id      text references public.sales_orders(id),
  add column if not exists sales_order_line_id text;
alter table public.work_order_material_lines
  add column if not exists required_count numeric;
do $$
begin
  if not exists (select 1 from pg_indexes
                 where schemaname = 'public' and indexname = 'work_orders_so_line_uidx') then
    create unique index work_orders_so_line_uidx
      on public.work_orders (sales_order_line_id) where sales_order_line_id is not null;
  end if;
end $$;

-- ============ RLS ============
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.sales_orders       enable row level security;
alter table public.sales_order_lines  enable row level security;

-- Any authenticated warehouse member can read orders / sales orders in
-- their warehouse (employees need to see what they're executing).
create policy orders_read on public.orders
  for select to authenticated using (public.in_warehouse(warehouse_id));
-- Draft editing + submission: manager/admin (matches the app's orderPolicy).
create policy orders_write on public.orders
  for all to authenticated
  using (public.in_warehouse(warehouse_id) and public.is_manager())
  with check (public.in_warehouse(warehouse_id) and public.is_manager());

create policy order_items_rw on public.order_items
  for all to authenticated
  using (exists (select 1 from public.orders o
                 where o.id = order_id
                   and public.in_warehouse(o.warehouse_id) and public.is_manager()))
  with check (exists (select 1 from public.orders o
                      where o.id = order_id
                        and public.in_warehouse(o.warehouse_id) and public.is_manager()));

create policy so_read on public.sales_orders
  for select to authenticated using (public.in_warehouse(warehouse_id));
-- Hold / resume / cancel: manager/admin. Release-to-warehouse and status
-- moves happen inside the release_sales_order_line RPC, which re-checks
-- supervisor-or-above membership itself.
create policy so_write on public.sales_orders
  for all to authenticated
  using (public.in_warehouse(warehouse_id) and public.is_manager())
  with check (public.in_warehouse(warehouse_id) and public.is_manager());

create policy so_lines_read on public.sales_order_lines
  for select to authenticated
  using (exists (select 1 from public.sales_orders s
                 where s.id = sales_order_id and public.in_warehouse(s.warehouse_id)));

-- ============ RPC: atomic order submission ============
-- Creates the sales order + all lines in one transaction. Idempotent: if the
-- order was already submitted, the existing sales order is returned.
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

-- ============ RPC: idempotent line release -> work order ============
-- Generates exactly one work order per sales-order material line. A retry on
-- an already-released line returns the existing work order (no duplicates).
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
  -- material line for the generated work order (idempotent on WO id)
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
  -- SO status rollup (mirrors the app's local release behavior).
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
