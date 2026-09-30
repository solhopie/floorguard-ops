-- FloorGuard Ops — Run 4 shared backend
-- Migration 0002: operations (assignments, cuts, cycle counts, discrepancies)
-- plus the atomic server-side RPCs that keep multi-device writes safe.

-- ============ inventory_assignments ============
-- Append-only lifecycle: RESERVED -> RELEASED | CONSUMED. Rows are never
-- deleted; status transitions only move forward.
create table public.inventory_assignments (
  id                text primary key,
  work_order_id     text not null references public.work_orders(id),
  line_id           text references public.work_order_material_lines(id),
  roll_id           text not null references public.rolls(id),
  warehouse_id      text not null references public.warehouses(id),
  required_in       integer not null default 0,
  reserved_in       integer not null default 0,
  actual_cut_in     integer,
  status            text not null default 'RESERVED'
                    check (status in ('RESERVED','RELEASED','CONSUMED')),
  employee_id       text references public.users(id),
  employee_name     text,
  location_code     text,
  mismatch_approved_by text,
  over_approved_by     text,
  roll_verified_at  timestamptz,
  roll_verified_by   text,
  location_verified_at timestamptz,
  location_verified_by text,
  released_at       timestamptz,
  released_by       text,
  consumed_at       timestamptz,
  consumed_by       text,
  cut_id            text,
  client_request_id text unique,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index assignments_wo_idx   on public.inventory_assignments (work_order_id);
create index assignments_roll_idx on public.inventory_assignments (roll_id);
create index assignments_status_idx on public.inventory_assignments (status);
create trigger assignments_touch before update on public.inventory_assignments
  for each row execute function public.touch_updated_at();

-- ============ cut_transactions ============
-- Append-only. client_request_id makes retries idempotent: a retried cut
-- with the same request id returns the original row instead of cutting twice.
create table public.cut_transactions (
  id                text primary key,
  roll_id           text not null references public.rolls(id),
  work_order_id     text references public.work_orders(id),
  assignment_id     text references public.inventory_assignments(id),
  prev_in           integer not null,
  cut_in            integer not null check (cut_in > 0),
  new_in            integer not null,
  employee_id       text references public.users(id),
  employee_name     text,
  warehouse_id      text not null references public.warehouses(id),
  location_code     text,
  client_request_id text not null unique,
  created_at        timestamptz not null default now()
);
create index cuts_roll_idx on public.cut_transactions (roll_id);
create index cuts_wo_idx   on public.cut_transactions (work_order_id);

-- ============ cycle_count_sessions ============
create table public.cycle_count_sessions (
  id            text primary key,
  warehouse_id  text not null references public.warehouses(id),
  mode          text not null default 'STANDARD'
                check (mode in ('STANDARD','RAPID','FREE_RUN','VERIFIED')),
  status        text not null default 'ACTIVE'
                check (status in ('ACTIVE','FINISHED','CANCELLED')),
  employee_id   text references public.users(id),
  employee_name text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index count_sessions_warehouse_idx on public.cycle_count_sessions (warehouse_id);
create trigger count_sessions_touch before update on public.cycle_count_sessions
  for each row execute function public.touch_updated_at();

-- ============ cycle_count_records ============
-- Immutable once written: recounts are new rows, never edits.
create table public.cycle_count_records (
  id              text primary key,
  session_id      text references public.cycle_count_sessions(id),
  roll_id         text not null references public.rolls(id),
  warehouse_id    text not null references public.warehouses(id),
  location_code   text,
  expected_in     integer not null default 0,
  measured_in     integer not null default 0,
  diff_in         integer not null default 0,
  status          text not null
                  check (status in ('MATCH','SHORT','OVER','LOCATION_MISMATCH','COLLECTED','NEEDS_REVIEW')),
  measured        boolean not null default true,
  employee_id     text references public.users(id),
  employee_name   text,
  counted_at      timestamptz not null default now(),
  note            text
);
create index count_records_roll_idx    on public.cycle_count_records (roll_id);
create index count_records_session_idx on public.cycle_count_records (session_id);

-- ============ discrepancies ============
create table public.discrepancies (
  id            text primary key,
  roll_id       text not null references public.rolls(id),
  warehouse_id  text not null references public.warehouses(id),
  kind          text not null,
  detail        text,
  status        text not null default 'OPEN' check (status in ('OPEN','RESOLVED')),
  raised_by     text,
  resolved_by   text,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index discrepancies_roll_idx on public.discrepancies (roll_id);
create trigger discrepancies_touch before update on public.discrepancies
  for each row execute function public.touch_updated_at();

-- ======================================================================
-- Atomic RPCs (SECURITY DEFINER so balance changes can ONLY happen here;
-- direct UPDATE on rolls is revoked from app roles in 0004_rls.sql).
-- Each function verifies the caller's warehouse membership via auth.uid().
-- ======================================================================

-- Resolve the caller's app user row (NULL when not signed in / not linked).
create or replace function public.caller_user()
returns public.users language sql stable security definer
set search_path = public as $$
  select u.* from public.users u
  where u.auth_user_id = auth.uid() and u.active
  limit 1;
$$;

-- record_cut: verify version -> insert cut -> update roll balance ->
-- consume assignment -> history + audit. All in one transaction.
-- Returns jsonb { ok:true, cut_id, new_balance_in, new_version, ... }
-- or { ok:false, error:{ code, message, ... } } for business conflicts.
create or replace function public.record_cut(
  p_roll_id text,
  p_order_number text,
  p_cut_in integer,
  p_employee_name text,
  p_location_code text,
  p_warehouse_id text,
  p_assignment_id text default null,
  p_client_request_id text default null,
  p_expected_version integer default null
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users;
  v_roll public.rolls;
  v_wo_id text;
  v_cut_id text;
  v_existing public.cut_transactions;
begin
  v_caller := public.caller_user();
  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'NOT_AUTHENTICATED', 'message', 'Sign in with a linked employee account.'));
  end if;
  if v_caller.warehouse_id <> p_warehouse_id and v_caller.role not in ('MANAGER','ADMIN') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'WAREHOUSE_FORBIDDEN', 'message', 'Employee is not a member of this warehouse.'));
  end if;

  -- Idempotent retry: same client request id returns the original cut.
  if p_client_request_id is not null then
    select * into v_existing from public.cut_transactions
      where client_request_id = p_client_request_id limit 1;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'cut_id', v_existing.id,
        'new_balance_in', v_existing.new_in);
    end if;
  end if;

  select * into v_roll from public.rolls where id = p_roll_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'ROLL_NOT_FOUND', 'message', 'Roll ' || p_roll_id || ' does not exist.'));
  end if;

  -- Optimistic concurrency: the device must have seen the current version.
  if p_expected_version is not null and v_roll.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'ROLL_VERSION_CONFLICT',
      'message', 'Roll was updated by another device.',
      'expected_version', p_expected_version,
      'current_version', v_roll.version,
      'current_balance_in', v_roll.expected_in));
  end if;

  if p_cut_in is null or p_cut_in <= 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'INVALID_CUT', 'message', 'Cut length must be more than zero.'));
  end if;
  if p_cut_in > v_roll.expected_in then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'INSUFFICIENT_BALANCE',
      'message', 'Cut exceeds the current balance.',
      'current_balance_in', v_roll.expected_in));
  end if;

  select id into v_wo_id from public.work_orders
    where warehouse_id = p_warehouse_id and number = upper(p_order_number) limit 1;

  v_cut_id := 'K' || upper(to_hex((extract(epoch from clock_timestamp())*1000000)::bigint));

  insert into public.cut_transactions
    (id, roll_id, work_order_id, assignment_id, prev_in, cut_in, new_in,
     employee_id, employee_name, warehouse_id, location_code, client_request_id)
  values
    (v_cut_id, p_roll_id, v_wo_id, p_assignment_id, v_roll.expected_in, p_cut_in,
     v_roll.expected_in - p_cut_in, v_caller.id, p_employee_name, p_warehouse_id,
     coalesce(p_location_code, v_roll.location_code), p_client_request_id);

  update public.rolls
    set expected_in = v_roll.expected_in - p_cut_in,
        version = v_roll.version + 1,
        last_cut_at = now()
    where id = p_roll_id;

  if p_assignment_id is not null then
    update public.inventory_assignments
      set status = 'CONSUMED', consumed_at = now(), consumed_by = p_employee_name,
          cut_id = v_cut_id, actual_cut_in = p_cut_in
      where id = p_assignment_id and status = 'RESERVED';
  end if;

  insert into public.history_events
    (id, roll_id, warehouse_id, event_type, employee_name, detail, at)
  values
    ('H' || upper(to_hex((extract(epoch from clock_timestamp())*1000000)::bigint)),
     p_roll_id, p_warehouse_id, 'CUT', p_employee_name,
     'Cut ' || p_cut_in || 'in, balance ' || v_roll.expected_in || 'in -> ' || (v_roll.expected_in - p_cut_in) || 'in',
     now());

  insert into public.audit_events
    (id, user_id, user_name, warehouse_id, action, entity_type, entity_id,
     related_roll_id, related_work_order_id, old_value, new_value)
  values
    ('A' || upper(to_hex((extract(epoch from clock_timestamp())*1000000)::bigint)),
     v_caller.id, p_employee_name, p_warehouse_id, 'CUT_RECORDED', 'cut', v_cut_id,
     p_roll_id, v_wo_id,
     jsonb_build_object('balance_in', v_roll.expected_in),
     jsonb_build_object('balance_in', v_roll.expected_in - p_cut_in, 'cut_in', p_cut_in));

  return jsonb_build_object('ok', true, 'cut_id', v_cut_id,
    'new_balance_in', v_roll.expected_in - p_cut_in,
    'new_version', v_roll.version + 1);
end $$;

-- reserve_inventory: version-checked reservation insert (idempotent).
create or replace function public.reserve_inventory(
  p_work_order_id text,
  p_line_id text,
  p_roll_id text,
  p_reserved_in integer,
  p_employee_name text,
  p_warehouse_id text,
  p_location_code text default null,
  p_client_request_id text default null,
  p_expected_version integer default null,
  p_mismatch_approved_by text default null,
  p_over_approved_by text default null
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users;
  v_roll public.rolls;
  v_assign_id text;
  v_existing public.inventory_assignments;
begin
  v_caller := public.caller_user();
  if v_caller is null then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'NOT_AUTHENTICATED', 'message', 'Sign in with a linked employee account.'));
  end if;
  if v_caller.warehouse_id <> p_warehouse_id and v_caller.role not in ('MANAGER','ADMIN') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'WAREHOUSE_FORBIDDEN', 'message', 'Employee is not a member of this warehouse.'));
  end if;

  if p_client_request_id is not null then
    select * into v_existing from public.inventory_assignments
      where client_request_id = p_client_request_id limit 1;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'assignment_id', v_existing.id);
    end if;
  end if;

  select * into v_roll from public.rolls where id = p_roll_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'ROLL_NOT_FOUND', 'message', 'Roll ' || p_roll_id || ' does not exist.'));
  end if;
  if p_expected_version is not null and v_roll.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'ROLL_VERSION_CONFLICT', 'message', 'Roll was updated by another device.',
      'expected_version', p_expected_version, 'current_version', v_roll.version,
      'current_balance_in', v_roll.expected_in));
  end if;
  if p_reserved_in is null or p_reserved_in <= 0 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'INVALID_QUANTITY', 'message', 'Reserved quantity must be greater than zero.'));
  end if;

  v_assign_id := 'A' || upper(to_hex((extract(epoch from clock_timestamp())*1000000)::bigint));

  insert into public.inventory_assignments
    (id, work_order_id, line_id, roll_id, warehouse_id, required_in, reserved_in,
     status, employee_id, employee_name, location_code,
     mismatch_approved_by, over_approved_by, client_request_id)
  select v_assign_id, p_work_order_id, p_line_id, p_roll_id, p_warehouse_id,
         coalesce((select required_in from public.work_order_material_lines where id = p_line_id), 0),
         p_reserved_in, 'RESERVED', v_caller.id, p_employee_name,
         coalesce(p_location_code, v_roll.location_code),
         p_mismatch_approved_by, p_over_approved_by, p_client_request_id;

  insert into public.history_events
    (id, roll_id, warehouse_id, event_type, employee_name, work_order_id, detail, at)
  values
    ('H' || upper(to_hex((extract(epoch from clock_timestamp())*1000000)::bigint)),
     p_roll_id, p_warehouse_id, 'INVENTORY_ASSIGNED', p_employee_name, p_work_order_id,
     'Reserved ' || p_reserved_in || 'in on roll ' || p_roll_id, now());

  insert into public.audit_events
    (id, user_id, user_name, warehouse_id, action, entity_type, entity_id,
     related_roll_id, related_work_order_id, new_value)
  values
    ('A' || upper(to_hex((extract(epoch from clock_timestamp())*1000000)::bigint)),
     v_caller.id, p_employee_name, p_warehouse_id, 'INVENTORY_ASSIGNED', 'inventory_assignment',
     v_assign_id, p_roll_id, p_work_order_id,
     jsonb_build_object('reserved_in', p_reserved_in, 'roll_version', v_roll.version));

  return jsonb_build_object('ok', true, 'assignment_id', v_assign_id,
    'roll_version', v_roll.version);
end $$;
