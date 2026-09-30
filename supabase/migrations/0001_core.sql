-- FloorGuard Ops — Run 4 shared backend
-- Migration 0001: core tables (warehouses, users, products, locations, rolls,
-- work orders + material lines).
--
-- Conventions:
--   * Stable TEXT primary keys so device-local IDs survive migration.
--   * All balances are INTEGER inches (never feet, never floats).
--   * Every operational table carries warehouse_id + created_at/updated_at.
--   * updated_at is maintained by trigger (see bottom of file).

create extension if not exists "pgcrypto";

-- ============ warehouses ============
create table public.warehouses (
  id            text primary key,
  name          text not null,
  timezone      text not null default 'America/New_York',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============ users ============
-- App employees. auth_user_id links a Supabase Auth user once the auth
-- bootstrap is done (see ../README.md). NULL = not yet linked; RLS denies
-- access until the link exists.
create table public.users (
  id            text primary key,
  display_name  text not null,
  role          text not null check (role in ('WAREHOUSE_EMPLOYEE','SUPERVISOR','MANAGER','ADMIN')),
  warehouse_id  text not null references public.warehouses(id),
  auth_user_id  uuid unique,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index users_warehouse_idx on public.users (warehouse_id);
create index users_auth_idx on public.users (auth_user_id);

-- ============ products ============
create table public.products (
  id            text primary key,
  warehouse_id  text not null references public.warehouses(id),
  manufacturer  text,
  style         text,
  color         text,
  material_type text,
  width_in      integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index products_warehouse_idx on public.products (warehouse_id);

-- ============ warehouse_locations ============
create table public.warehouse_locations (
  id            text primary key,
  warehouse_id  text not null references public.warehouses(id),
  code          text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (warehouse_id, code)
);

-- ============ rolls ============
-- One canonical roll record. Balances are integer inches.
-- version + updated_at implement optimistic concurrency: every
-- balance-changing RPC checks the version the device saw before writing.
create table public.rolls (
  id                text primary key,
  barcode           text not null,
  warehouse_id      text not null references public.warehouses(id),
  manufacturer      text,
  style             text,
  color             text,
  material_type     text,
  width_in          integer,
  beginning_in      integer not null default 0,
  expected_in       integer not null default 0,
  measured_in       integer,
  measured_at       timestamptz,
  measured_by       text,
  location_code     text,
  last_cut_at       timestamptz,
  version           integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index rolls_warehouse_idx on public.rolls (warehouse_id);
create index rolls_barcode_idx on public.rolls (barcode);

-- ============ work_orders ============
create table public.work_orders (
  id                text primary key,
  number            text not null,
  warehouse_id      text not null references public.warehouses(id),
  property          text,
  account           text,
  status            text not null default 'OPEN',
  assignment_status text not null default 'UNASSIGNED',
  assignee_id       text references public.users(id),
  scheduled_date    date,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (warehouse_id, number)
);
create index work_orders_warehouse_idx on public.work_orders (warehouse_id);

-- ============ work_order_material_lines ============
create table public.work_order_material_lines (
  id            text primary key,
  work_order_id text not null references public.work_orders(id) on delete cascade,
  material_type text,
  style         text,
  color         text,
  width_in      integer,
  required_in   integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index material_lines_wo_idx on public.work_order_material_lines (work_order_id);

-- ============ updated_at trigger ============
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger warehouses_touch       before update on public.warehouses       for each row execute function public.touch_updated_at();
create trigger users_touch            before update on public.users            for each row execute function public.touch_updated_at();
create trigger products_touch         before update on public.products         for each row execute function public.touch_updated_at();
create trigger locations_touch        before update on public.warehouse_locations for each row execute function public.touch_updated_at();
create trigger rolls_touch            before update on public.rolls            for each row execute function public.touch_updated_at();
create trigger work_orders_touch      before update on public.work_orders      for each row execute function public.touch_updated_at();
create trigger material_lines_touch  before update on public.work_order_material_lines for each row execute function public.touch_updated_at();
