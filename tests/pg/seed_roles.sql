-- Run 9 validation seed: two warehouses, four distinct role identities in
-- warehouse A, one employee in warehouse B. auth_user_id values are stable
-- UUIDs so the Node harness can impersonate each role by setting
-- request.jwt.claim.sub before calling RPCs as the test_app login role.
insert into public.warehouses (id, name) values
  ('WHA', 'Warehouse A — Pilot'),
  ('WHB', 'Warehouse B — Isolation')
on conflict (id) do nothing;

insert into public.users (id, display_name, role, warehouse_id, auth_user_id, active) values
  ('U-EMP-A',  'Eddie Employee',   'WAREHOUSE_EMPLOYEE', 'WHA', '11111111-1111-1111-1111-111111111111', true),
  ('U-SUP-A',  'Sam Supervisor',   'SUPERVISOR',         'WHA', '22222222-2222-2222-2222-222222222222', true),
  ('U-MGR-A',  'Mia Manager',      'MANAGER',            'WHA', '33333333-3333-3333-3333-333333333333', true),
  ('U-ADM-A',  'Ada Admin',        'ADMIN',              'WHA', '44444444-4444-4444-4444-444444444444', true),
  ('U-EMP-B',  'Ben Employee',     'WAREHOUSE_EMPLOYEE', 'WHB', '55555555-5555-5555-5555-555555555555', true),
  ('U-SUP-B',  'Sue Supervisor',   'SUPERVISOR',         'WHB', '66666666-6666-6666-6666-666666666666', true)
on conflict (id) do update set
  display_name = excluded.display_name, role = excluded.role,
  warehouse_id = excluded.warehouse_id, auth_user_id = excluded.auth_user_id,
  active = excluded.active;
