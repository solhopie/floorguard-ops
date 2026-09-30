-- FloorGuard Ops — Run 4 shared backend
-- Demo seed. Run AFTER the migrations. auth_user_id stays NULL until the
-- owner creates Supabase Auth users and links them (see ../README.md).

insert into public.warehouses (id, name, timezone, active) values
  ('main', 'Main Warehouse', 'America/New_York', true)
on conflict (id) do nothing;

insert into public.users (id, display_name, role, warehouse_id, active) values
  ('u-marcus', 'Marcus', 'MANAGER',           'main', true),
  ('u-dana',   'Dana',   'WAREHOUSE_EMPLOYEE','main', true),
  ('u-luis',   'Luis',   'WAREHOUSE_EMPLOYEE','main', true)
on conflict (id) do nothing;

insert into public.warehouse_locations (id, warehouse_id, code, active) values
  ('loc-205a', 'main', '205A', true),
  ('loc-205b', 'main', '205B', true),
  ('loc-206a', 'main', '206A', true),
  ('loc-206b', 'main', '206B', true),
  ('loc-204a', 'main', '204A', true),
  ('loc-204b', 'main', '204B', true)
on conflict (id) do nothing;

insert into public.rolls
  (id, barcode, warehouse_id, manufacturer, style, color, material_type,
   width_in, beginning_in, expected_in, location_code, version) values
  ('16628697', '16628697', 'main', 'Shaw', 'Marvel', 'Chrome', 'Carpet',
   144, 1034, 1034, '205B', 1),
  ('16628698', '16628698', 'main', 'Shaw', 'Marvel', 'Chrome', 'Carpet',
   144, 366, 366, '206B', 1),
  ('QH5CPHN', 'QH5CPHN', 'main', 'Shaw Industries', 'Venture Solid', 'Soft Taupe', 'Carpet',
   144, 1801, 536, '205B', 1),
  ('TK7M2QA', 'TK7M2QA', 'main', 'Mohawk Industries', 'EverStrand Soft', 'Harbor Gray', 'Carpet',
   144, 1440, 1240, '205A', 1)
on conflict (id) do nothing;

insert into public.work_orders
  (id, number, warehouse_id, property, account, status, assignment_status) values
  ('wo-xs024536', 'XS024536', 'main', 'Ventura Pointe', 'Willowbridge', 'OPEN', 'UNASSIGNED'),
  ('wo-xs024537', 'XS024537', 'main', 'Harbor Ridge',   'Willowbridge', 'OPEN', 'UNASSIGNED')
on conflict (id) do nothing;

insert into public.work_order_material_lines
  (id, work_order_id, material_type, style, color, width_in, required_in) values
  ('XS024536-L1', 'wo-xs024536', 'Carpet', 'Marvel', 'Chrome', 144, 237),
  ('XS024537-L1', 'wo-xs024537', 'Carpet', 'Marvel', 'Chrome', 144, 495)
on conflict (id) do nothing;
