-- FloorGuard Ops — Run 4 shared backend
-- Migration 0003: roll history ledger, documents (history cards), extraction
-- imports, and the central audit trail. History is append-only: rows are
-- inserted, never updated or deleted (enforced in 0004_rls.sql).

-- ============ history_events ============
-- The shared Roll Ledger. One row per event; balances are derived from
-- cut_transactions, never edited here.
create table public.history_events (
  id            text primary key,
  roll_id       text not null references public.rolls(id),
  warehouse_id  text not null references public.warehouses(id),
  event_type    text not null check (event_type in (
                  'ROLL_DISCOVERED','INVENTORY_ASSIGNED','INVENTORY_RELEASED',
                  'CUT','BALANCE_UPDATED','PHYSICAL_MEASUREMENT','CYCLE_COUNT',
                  'LOCATION_OBSERVED','LOCATION_CHANGED','HISTORY_CARD_CAPTURED',
                  'DOCUMENT_IMPORTED','DISCREPANCY','SUPERVISOR_REVIEW',
                  'ASSIGNMENT_CONSUMED')),
  employee_name text,
  work_order_id text references public.work_orders(id),
  detail        text,
  at            timestamptz not null default now()
);
create index history_roll_idx on public.history_events (roll_id, at desc);

-- ============ documents ============
-- Metadata for history-card images. The bytes live in the private
-- `history-cards` storage bucket; storage_path is never reused and rows
-- are never updated, so an image can never be silently overwritten.
create table public.documents (
  id              text primary key,
  roll_id         text not null references public.rolls(id),
  warehouse_id    text not null references public.warehouses(id),
  storage_path    text not null unique,
  document_type   text not null default 'HISTORY_CARD',
  employee_id     text references public.users(id),
  employee_name   text,
  location_code   text,
  session_id      text,
  captured_at     timestamptz not null default now(),
  original_filename text,
  mime_type       text,
  byte_size       integer,
  created_at      timestamptz not null default now()
);
create index documents_roll_idx on public.documents (roll_id);

-- ============ history_card_imports ============
-- UNVERIFIED extraction results. Confirming/editing/ignoring an import only
-- ever writes timeline events — it can never touch trusted balances.
create table public.history_card_imports (
  id            text primary key,
  document_id   text not null references public.documents(id),
  roll_id       text not null references public.rolls(id),
  warehouse_id  text not null references public.warehouses(id),
  extracted     jsonb not null default '{}'::jsonb,
  status        text not null default 'UNVERIFIED'
                check (status in ('UNVERIFIED','CONFIRMED','EDITED','IGNORED')),
  reviewed_by   text,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index imports_doc_idx on public.history_card_imports (document_id);

-- ============ audit_events ============
-- Central audit trail: who did what, to which entity, with old/new values.
create table public.audit_events (
  id                  text primary key,
  user_id             text references public.users(id),
  user_name           text,
  warehouse_id        text not null references public.warehouses(id),
  action              text not null,
  entity_type         text not null,
  entity_id           text,
  related_work_order_id text references public.work_orders(id),
  related_roll_id     text references public.rolls(id),
  old_value           jsonb,
  new_value           jsonb,
  created_at          timestamptz not null default now()
);
create index audit_warehouse_idx on public.audit_events (warehouse_id, created_at desc);
create index audit_action_idx    on public.audit_events (action);
