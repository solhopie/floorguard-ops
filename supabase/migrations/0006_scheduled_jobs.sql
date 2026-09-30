--- FloorGuard Ops — migration 0006: Scheduled Jobs / Daily Warehouse Queue
---
--- Run 5 adds scheduling fields to the EXISTING work_orders table. There is
--- no second scheduling database: scheduled jobs ARE work orders.
--- Readiness (WAITING FOR INVENTORY / READY TO CUT / IN PROGRESS / ...) is
--- derived by the client from work orders + material lines + inventory
--- assignments + cut transactions + audit events, and is never stored.
--- Work-order-level audit (holds, notes, completions, assignments) goes to
--- the existing audit_events table with entity_type = 'work_order'.

alter table public.work_orders
  add column if not exists priority text not null default 'NORMAL'
    check (priority in ('NORMAL', 'HIGH', 'URGENT')),
  add column if not exists scheduled_time text,
  add column if not exists on_hold boolean not null default false,
  add column if not exists hold_reason text,
  add column if not exists hold_at timestamptz,
  add column if not exists hold_by text,
  add column if not exists warehouse_completed_at timestamptz,
  add column if not exists warehouse_completed_by text;

create index if not exists work_orders_scheduled_idx
  on public.work_orders (warehouse_id, scheduled_date);
create index if not exists work_orders_hold_idx
  on public.work_orders (warehouse_id, on_hold) where on_hold;
