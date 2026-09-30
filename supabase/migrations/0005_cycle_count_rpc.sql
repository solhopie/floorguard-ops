-- FloorGuard Ops — Run 4 shared backend
-- Migration 0005: atomic cycle-count RPC.
--
-- Direct UPDATE on rolls stays revoked (see 0004_rls.sql); the measured-
-- balance (MB) stamp therefore goes through this SECURITY DEFINER function,
-- which also writes the count record, the PHYSICAL_MEASUREMENT history
-- event, and the audit row in ONE transaction.

create or replace function public.record_cycle_count(
  p_roll_id text,
  p_warehouse_id text,
  p_location_code text,
  p_expected_in integer,
  p_measured_in integer,
  p_status text,
  p_employee_name text,
  p_session_id text default null,
  p_note text default null
)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  v_caller public.users;
  v_roll public.rolls;
  v_rec_id text;
  v_diff integer;
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

  if p_status not in ('MATCH','SHORT','OVER','LOCATION_MISMATCH','COLLECTED','NEEDS_REVIEW') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'INVALID_STATUS', 'message', 'Unknown count status.'));
  end if;

  select * into v_roll from public.rolls where id = p_roll_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'ROLL_NOT_FOUND', 'message', 'Roll ' || p_roll_id || ' does not exist.'));
  end if;

  v_diff := p_measured_in - p_expected_in;
  v_rec_id := 'C' || upper(to_hex((extract(epoch from clock_timestamp())*1000000)::bigint));

  insert into public.cycle_count_records
    (id, session_id, roll_id, warehouse_id, location_code, expected_in,
     measured_in, diff_in, status, measured, employee_id, employee_name, note)
  values
    (v_rec_id, p_session_id, p_roll_id, p_warehouse_id, p_location_code,
     p_expected_in, p_measured_in, v_diff, p_status, true,
     v_caller.id, p_employee_name, p_note);

  -- MB stamp: the physical measurement, kept next to the expected balance.
  -- Never changes expected_in — counts never move trusted balances.
  -- The optimistic version is NOT bumped: a measurement does not invalidate
  -- another device's balance assumption, so in-flight cuts stay valid.
  update public.rolls
    set measured_in = p_measured_in, measured_at = now(),
        measured_by = p_employee_name
    where id = p_roll_id;

  insert into public.history_events
    (id, roll_id, warehouse_id, event_type, employee_name, detail, at)
  values
    ('H' || upper(to_hex((extract(epoch from clock_timestamp())*1000000)::bigint)),
     p_roll_id, p_warehouse_id, 'PHYSICAL_MEASUREMENT', p_employee_name,
     'Measured ' || p_measured_in || 'in vs expected ' || p_expected_in || 'in (' || p_status || ')',
     now());

  insert into public.audit_events
    (id, user_id, user_name, warehouse_id, action, entity_type, entity_id,
     related_roll_id, new_value)
  values
    ('A' || upper(to_hex((extract(epoch from clock_timestamp())*1000000)::bigint)),
     v_caller.id, p_employee_name, p_warehouse_id, 'CYCLE_COUNT_RECORDED',
     'cycle_count_record', v_rec_id, p_roll_id,
     jsonb_build_object('measured_in', p_measured_in, 'expected_in', p_expected_in,
                        'status', p_status, 'roll_version', v_roll.version));

  return jsonb_build_object('ok', true, 'record_id', v_rec_id,
    'diff_in', v_diff, 'roll_version', v_roll.version);
end $$;

grant execute on function public.record_cycle_count(text,text,text,integer,integer,text,text,text,text) to authenticated;
revoke execute on function public.record_cycle_count(text,text,text,integer,integer,text,text,text,text) from anon;
