-- 0010_remnant_compatibility.sql
-- Run 9: move returned-remnant material-compatibility enforcement server-side.
--
-- Before a returned remnant can be reserved for a work-order material line,
-- the remnant's material attributes (material_type, style, color, width_in)
-- must match the line's expected material. A mismatch is REJECTED unless a
-- SUPERVISOR-or-above caller supplies an override reason; the override is
-- stored (reason, user, work order, remnant, expected vs actual material,
-- timestamp) and a MATERIAL_COMPATIBILITY_OVERRIDE audit event is written.
-- WAREHOUSE_EMPLOYEE can never perform the override.

-- ============ remnant_compatibility_overrides ============
create table public.remnant_compatibility_overrides (
  id                text primary key,
  warehouse_id      text not null references public.warehouses(id),
  work_order_id     text not null,
  line_id           text,
  remnant_id        text not null references public.returned_remnants(id),
  expected_material jsonb not null,
  actual_material   jsonb not null,
  reason            text not null,
  created_by        text not null references public.users(id),
  created_by_name   text,
  created_at        timestamptz not null default now()
);
create index if not exists rco_warehouse_idx on public.remnant_compatibility_overrides (warehouse_id);
create index if not exists rco_remnant_idx   on public.remnant_compatibility_overrides (remnant_id);

alter table public.remnant_compatibility_overrides enable row level security;
drop policy if exists rco_read on public.remnant_compatibility_overrides;
create policy rco_read on public.remnant_compatibility_overrides
  for select to authenticated using (public.in_warehouse(warehouse_id));
-- No insert/update/delete policies: rows are written only by reserve_remnant
-- (security definer). The override trail is append-only.

-- ============ returned_remnants status lifecycle fix ============
-- 0009's reserve_remnant sets status = 'ASSIGNED', but the 0009 check
-- constraint did not list ASSIGNED, so every reservation failed at the
-- database level. Widen the allowed statuses to cover the full lifecycle.
alter table public.returned_remnants drop constraint if exists returned_remnants_status_check;
alter table public.returned_remnants
  add constraint returned_remnants_status_check
  check (status in ('AVAILABLE','ASSIGNED','RELEASED','CONSUMED',
                   'QUARANTINED','SCRAPPED','VENDOR_RETURN','HOLD'));

-- ============ reserve_remnant (compatibility-enforcing version) ============
-- Supersedes the 0009 version: adds p_override_reason and performs the
-- material-compatibility check server-side.
drop function if exists
  public.reserve_remnant(text,text,text,integer,text,text,text,text,text);

create or replace function public.reserve_remnant(
  p_work_order_id text,
  p_line_id text,
  p_remnant_id text,
  p_reserved_in integer,
  p_employee_name text,
  p_warehouse_id text,
  p_location_code text default null,
  p_client_request_id text default null,
  p_mismatch_approved_by text default null,
  p_override_reason text default null
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users;
  v_rem public.returned_remnants;
  v_line public.work_order_material_lines;
  v_assign_id text;
  v_existing public.inventory_assignments;
  v_expected jsonb;
  v_actual jsonb;
  v_mismatch_fields text[] := '{}';
  v_override_id text;
begin
  v_caller := public.return_caller();
  if v_caller is null then
    return public.return_fail('NOT_AUTHENTICATED', 'Sign in is required.');
  end if;
  if not public.in_warehouse(p_warehouse_id) then
    return public.return_fail('NOT_AUTHORIZED', 'Not a member of this warehouse.');
  end if;

  if p_client_request_id is not null then
    select * into v_existing from public.inventory_assignments
      where client_request_id = p_client_request_id limit 1;
    if found then
      return jsonb_build_object('ok', true, 'duplicate', true, 'assignment_id', v_existing.id);
    end if;
  end if;

  select * into v_rem from public.returned_remnants where id = p_remnant_id for update;
  if not found then
    return public.return_fail('REMNANT_NOT_FOUND', 'Remnant does not exist.');
  end if;
  if v_rem.warehouse_id <> p_warehouse_id then
    return public.return_fail('NOT_AUTHORIZED', 'Remnant is not in this warehouse.');
  end if;
  if v_rem.status <> 'AVAILABLE' then
    return public.return_fail('REMNANT_NOT_AVAILABLE',
      'Remnant is ' || v_rem.status || ' (only AVAILABLE remnants can be assigned).');
  end if;
  if p_reserved_in is null or p_reserved_in <= 0 then
    return public.return_fail('INVALID_QUANTITY', 'Reserved quantity must be greater than zero.');
  end if;
  if p_reserved_in > v_rem.length_in then
    return public.return_fail('INSUFFICIENT_LENGTH',
      'Remnant has ' || v_rem.length_in || ' in; cannot reserve ' || p_reserved_in || ' in.');
  end if;

  -- ---- server-side material compatibility ----
  if p_line_id is not null then
    select * into v_line from public.work_order_material_lines where id = p_line_id;
    if found then
      v_expected := jsonb_build_object(
        'material_type', v_line.material_type, 'style', v_line.style,
        'color', v_line.color, 'width_in', v_line.width_in);
      v_actual := jsonb_build_object(
        'material_type', v_rem.material_type, 'style', v_rem.style,
        'color', v_rem.color, 'width_in', v_rem.width_in);

      if nullif(btrim(lower(coalesce(v_line.material_type,''))), '') is not null
         and nullif(btrim(lower(coalesce(v_rem.material_type,''))), '') is not null
         and btrim(lower(v_line.material_type)) <> btrim(lower(v_rem.material_type)) then
        v_mismatch_fields := array_append(v_mismatch_fields, 'material_type');
      end if;
      if nullif(btrim(lower(coalesce(v_line.style,''))), '') is not null
         and nullif(btrim(lower(coalesce(v_rem.style,''))), '') is not null
         and btrim(lower(v_line.style)) <> btrim(lower(v_rem.style)) then
        v_mismatch_fields := array_append(v_mismatch_fields, 'style');
      end if;
      if nullif(btrim(lower(coalesce(v_line.color,''))), '') is not null
         and nullif(btrim(lower(coalesce(v_rem.color,''))), '') is not null
         and btrim(lower(v_line.color)) <> btrim(lower(v_rem.color)) then
        v_mismatch_fields := array_append(v_mismatch_fields, 'color');
      end if;
      if v_line.width_in is not null and v_rem.width_in is not null
         and v_line.width_in <> v_rem.width_in then
        v_mismatch_fields := array_append(v_mismatch_fields, 'width_in');
      end if;

      if array_length(v_mismatch_fields, 1) > 0 then
        -- Mismatch: supervisor-or-above override with a recorded reason required.
        if v_caller.role not in ('SUPERVISOR','MANAGER','ADMIN') then
          return public.return_fail('COMPATIBILITY_OVERRIDE_DENIED',
            'Material mismatch (' || array_to_string(v_mismatch_fields, ', ') ||
            '): only a Supervisor or above can approve this reservation.');
        end if;
        if p_override_reason is null or btrim(p_override_reason) = '' then
          return public.return_fail('COMPATIBILITY_MISMATCH',
            'Material mismatch (' || array_to_string(v_mismatch_fields, ', ') ||
            '): a supervisor override reason is required.');
        end if;

        v_override_id := 'OVR' || substring(md5(random()::text || clock_timestamp()::text), 1, 12);
        insert into public.remnant_compatibility_overrides
          (id, warehouse_id, work_order_id, line_id, remnant_id,
           expected_material, actual_material, reason, created_by, created_by_name)
        values
          (v_override_id, p_warehouse_id, p_work_order_id, p_line_id, p_remnant_id,
           v_expected, v_actual, btrim(p_override_reason), v_caller.id,
           coalesce(p_employee_name, v_caller.id));

        insert into public.audit_events
          (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
        values
          ('A' || substring(md5(random()::text), 1, 12), p_warehouse_id,
           'MATERIAL_COMPATIBILITY_OVERRIDE', 'remnant_compatibility_override', v_override_id,
           coalesce(p_employee_name, v_caller.id),
           jsonb_build_object(
             'remnant_id', p_remnant_id, 'remnant_number', v_rem.remnant_number,
             'work_order_id', p_work_order_id, 'line_id', p_line_id,
             'mismatch_fields', v_mismatch_fields,
             'expected', v_expected, 'actual', v_actual,
             'reason', btrim(p_override_reason),
             'approved_by', v_caller.id, 'approved_by_role', v_caller.role));
      end if;
    end if;
  end if;

  v_assign_id := 'A' || substring(md5(random()::text || clock_timestamp()::text), 1, 12);

  insert into public.inventory_assignments
    (id, work_order_id, line_id, remnant_id, warehouse_id, required_in, reserved_in,
     status, employee_id, employee_name, location_code,
     mismatch_approved_by, client_request_id)
  select v_assign_id, p_work_order_id, p_line_id, p_remnant_id, p_warehouse_id,
         coalesce((select required_in from public.work_order_material_lines where id = p_line_id), 0),
         p_reserved_in, 'RESERVED', v_caller.id, p_employee_name,
         coalesce(p_location_code, v_rem.location_code),
         case when array_length(v_mismatch_fields, 1) > 0
              then coalesce(p_mismatch_approved_by, v_caller.id)
              else p_mismatch_approved_by end,
         p_client_request_id;

  update public.returned_remnants
     set status = 'ASSIGNED', updated_at = now()
   where id = p_remnant_id;

  insert into public.audit_events
    (id, warehouse_id, action, entity_type, entity_id, user_name, new_value)
  values
    ('A' || substring(md5(random()::text), 1, 12), p_warehouse_id,
     'REMNANT_ASSIGNED', 'inventory_assignment', v_assign_id, coalesce(p_employee_name, v_caller.id),
     jsonb_build_object('remnant_id', p_remnant_id, 'remnant_number', v_rem.remnant_number,
       'work_order_id', p_work_order_id, 'reserved_in', p_reserved_in,
       'override_id', v_override_id,
       'detail', 'Remnant ' || v_rem.remnant_number || ' reserved for work order. Parent roll untouched.'));

  return jsonb_build_object('ok', true, 'duplicate', false,
    'assignment_id', v_assign_id, 'remnant_number', v_rem.remnant_number,
    'override_id', v_override_id,
    'compatibility_override', v_override_id is not null);
end;
$$;
grant execute on function
  public.reserve_remnant(text,text,text,integer,text,text,text,text,text,text)
  to authenticated;
