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
  (id, number, warehouse_id, property, account, status, assignment_status,
   scheduled_date, scheduled_time, priority) values
  ('wo-xs024536', 'XS024536', 'main', 'Ventura Pointe', 'Willowbridge', 'OPEN', 'UNASSIGNED',
   CURRENT_DATE, '09:00', 'HIGH'),
  ('wo-xs024537', 'XS024537', 'main', 'Harbor Ridge',   'Willowbridge', 'OPEN', 'UNASSIGNED',
   CURRENT_DATE + 1, '10:30', 'NORMAL')
on conflict (id) do nothing;

insert into public.work_order_material_lines
  (id, work_order_id, material_type, style, color, width_in, required_in) values
  ('XS024536-L1', 'wo-xs024536', 'Carpet', 'Marvel', 'Chrome', 144, 237),
  ('XS024537-L1', 'wo-xs024537', 'Carpet', 'Marvel', 'Chrome', 144, 495)
on conflict (id) do nothing;

-- Run 6: fictional development order + sales order (clearly not real data).
-- Mirrors the local demo fixtures: SO-100245 with two OPEN lines.
insert into public.orders
  (id, number, warehouse_id, property, account, requested_date, scheduled_date,
   priority, created_by, internal_ref, notes, status, submitted_at) values
  ('ord-1000', 'ORD-1000', 'main', 'Ventura Pointe', 'Willowbridge',
   CURRENT_DATE - 2, CURRENT_DATE, 'NORMAL', 'Marcus', 'DEV-REF-1',
   'Fictional development order.', 'SUBMITTED', CURRENT_DATE - 2)
on conflict (id) do nothing;

insert into public.order_items
  (id, order_id, seq, style, color, material_type, uom, width_in, quantity_in, quantity) values
  ('ord-1000-i1', 'ord-1000', 1, 'Marvel', 'Chrome', 'CARPET', 'LF', 144, 237, null),
  ('ord-1000-i2', 'ord-1000', 2, 'Rebond Pad', 'Natural', 'PAD', 'LF', 144, 237, null)
on conflict (id) do nothing;

insert into public.sales_orders
  (id, number, source_order_id, warehouse_id, property, account, priority,
   requested_date, scheduled_date, status, created_by, submitted_by, notes,
   submitted_at) values
  ('so-100245', 'SO-100245', 'ord-1000', 'main', 'Ventura Pointe', 'Willowbridge',
   'NORMAL', CURRENT_DATE - 2, CURRENT_DATE, 'OPEN', 'Marcus', 'Marcus',
   'Fictional development sales order.', CURRENT_DATE - 2)
on conflict (id) do nothing;

insert into public.sales_order_lines
  (id, sales_order_id, seq, source_item_id, style, color, material_type, uom,
   width_in, ordered_in, ordered_qty, warehouse_qty_required, status) values
  ('so-100245-l1', 'so-100245', 1, 'ord-1000-i1', 'Marvel', 'Chrome', 'CARPET', 'LF',
   144, 237, null, 237, 'OPEN'),
  ('so-100245-l2', 'so-100245', 2, 'ord-1000-i2', 'Rebond Pad', 'Natural', 'PAD', 'LF',
   144, 237, null, 237, 'OPEN')
on conflict (id) do nothing;

update public.orders set sales_order_id = 'so-100245' where id = 'ord-1000';
