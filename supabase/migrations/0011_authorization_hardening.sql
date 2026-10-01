-- 0011_authorization_hardening.sql
-- Run 9: close authorization gaps found in the server-side role-matrix audit.
--
-- 1. reserve_inventory: p_mismatch_approved_by / p_over_approved_by were
--    stored as free text with no verification. Now, supplying either
--    requires the authenticated caller to be SUPERVISOR or above
--    (APPROVAL_DENIED otherwise).
-- 2. check_assignment_transition: inventory release (RESERVED -> RELEASED /
--    CONSUMED) previously relied on an RLS policy that let any warehouse
--    member change assignment status. The trigger now enforces SUPERVISOR or
--    above for status transitions, on every path (RPC or direct write).
--    Metadata edits that do not change status are unaffected.


-- ============ inventory release: supervisor+ enforced in the trigger ============
create or replace function public.check_assignment_transition()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if old.status = new.status then return new; end if; -- metadata edits allowed
  if old.status = 'RESERVED' and new.status in ('RELEASED','CONSUMED') then
    if not public.is_supervisor_or_above() then
      raise exception 'Inventory release requires a Supervisor or above.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Illegal assignment transition % -> %', old.status, new.status;
end $$;

-- ============ reserve_inventory: verify approval authority ============
CREATE OR REPLACE FUNCTION public.reserve_inventory(p_work_order_id text, p_line_id text, p_roll_id text, p_reserved_in integer, p_employee_name text, p_warehouse_id text, p_location_code text DEFAULT NULL::text, p_client_request_id text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer, p_mismatch_approved_by text DEFAULT NULL::text, p_over_approved_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Run 9: a named mismatch/over-reservation approval is only meaningful when
  -- the authenticated caller actually holds override authority. A free-text
  -- approver name from an employee is rejected server-side.
  if nullif(btrim(coalesce(p_mismatch_approved_by, '')), '') is not null
     or nullif(btrim(coalesce(p_over_approved_by, '')), '') is not null then
    if v_caller.role not in ('SUPERVISOR','MANAGER','ADMIN') then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object(
        'code', 'APPROVAL_DENIED',
        'message', 'Mismatch or over-reservation approval requires a Supervisor or above.'));
    end if;
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
end $function$;

grant execute on function public.reserve_inventory(text,text,text,integer,text,text,text,text,integer,text,text) to authenticated;
