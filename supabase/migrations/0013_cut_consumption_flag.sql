-- 0013_cut_consumption_flag.sql
-- Run 9: preserve the legitimate employee cut flow. record_cut atomically
-- flips a referenced assignment RESERVED -> CONSUMED; the hardened
-- check_assignment_transition trigger would otherwise reject employee cuts.
-- record_cut sets a transaction-local flag authorizing exactly that one
-- atomic transition. Standalone releases still require Supervisor or above.

-- ============ assignment transition trigger: cut-aware ============
create or replace function public.check_assignment_transition()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  if old.status = new.status then return new; end if; -- metadata edits allowed
  -- Atomic cut consumption (flag set by record_cut in the same transaction):
  -- the employee performing the cut consumes the reservation. Authorized by
  -- record_cut's own warehouse/version checks.
  if old.status = 'RESERVED' and new.status = 'CONSUMED'
     and current_setting('request.fg_cut_consuming', true) = '1' then
    return new;
  end if;
  if old.status = 'RESERVED' and new.status in ('RELEASED','CONSUMED') then
    if not public.is_supervisor_or_above() then
      raise exception 'Inventory release requires a Supervisor or above.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Illegal assignment transition % -> %', old.status, new.status;
end $$;

-- ============ record_cut: set the atomic-consumption flag ============
CREATE OR REPLACE FUNCTION public.record_cut(p_roll_id text, p_order_number text, p_cut_in integer, p_employee_name text, p_location_code text, p_warehouse_id text, p_assignment_id text DEFAULT NULL::text, p_client_request_id text DEFAULT NULL::text, p_expected_version integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- Run 9: mark this atomic cut-consumption so the assignment trigger
    -- allows the RESERVED -> CONSUMED transition (record_cut authorizes it).
    perform set_config('request.fg_cut_consuming', '1', true);
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
end $function$;

grant execute on function public.record_cut(text,text,integer,text,text,text,text,text,integer) to authenticated;
