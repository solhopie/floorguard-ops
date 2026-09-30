/* FloorGuard Ops — Run 4 test double for Supabase PostgREST + RPC + Storage + Auth.
   A tiny in-memory HTTP server that faithfully implements the backend
   CONTRACT the app depends on (not the SQL): table reads/writes, the three
   atomic RPCs (record_cut, reserve_inventory, record_cycle_count) with
   optimistic version checks + idempotency, auth-gated writes, and the
   private history-cards storage bucket.
   Run: required by tests/run4.test.js (started automatically). */
var http = require('http');
var url = require('url');

var TABLES = [
  'warehouses', 'users', 'products', 'warehouse_locations', 'rolls',
  'work_orders', 'work_order_material_lines', 'inventory_assignments',
  'cut_transactions', 'cycle_count_sessions', 'cycle_count_records',
  'history_events', 'documents', 'history_card_imports', 'discrepancies',
  'audit_events',
  /* Run 6: commercial layer. */
  'orders', 'order_items', 'sales_orders', 'sales_order_lines',
  /* Run 7: central numbering + loadout + receipts. */
  'business_number_counters', 'number_issues',
  'loadouts', 'loadout_lines', 'loadout_exceptions',
  'receipts', 'receipt_lines', 'receipt_exceptions'
];

var NUMBER_SEED = { ORD: ['ORD-', 100001], SO: ['SO-', 100001], WO: ['WO-', 200001],
                    RCV: ['RCV-', 100001], LOAD: ['LOAD-', 100001] };

function startDouble() {
  var seq = 1000;
  var state = {
    tables: {},      /* name -> Map(id -> row) */
    storage: {},     /* 'history-cards/<path>' -> Buffer */
    idempotency: {}, /* client_request_id -> rpc result */
    sessions: {}     /* access_token -> {email} */
  };
  TABLES.forEach(function (t) { state.tables[t] = new Map(); });

  function nid(p) { return p + (++seq).toString(36).toUpperCase(); }

  /* Seed: mirrors supabase/seed.sql (demo warehouse + two rolls + two WOs). */
  function seed() {
    Object.keys(NUMBER_SEED).forEach(function (k) {
      state.tables.business_number_counters.set(k,
        { kind: k, prefix: NUMBER_SEED[k][0], next_val: NUMBER_SEED[k][1] });
    });
    var todayD = new Date(), tomD = new Date(todayD.getTime() + 86400000);
    function dstr(d) { return d.toISOString().slice(0, 10); }
    var rolls = state.tables.rolls;
    rolls.set('16628697', { id: '16628697', barcode: '16628697', style: 'Marvel', color: 'Chrome',
      material_type: 'carpet', width_in: 144, beginning_in: 1034, expected_in: 1034,
      location_code: '205B', version: 1, warehouse_id: 'main', discovered: false,
      measured_in: null, measured_at: null, measured_by: null });
    rolls.set('16628698', { id: '16628698', barcode: '16628698', style: 'Marvel', color: 'Chrome',
      material_type: 'carpet', width_in: 144, beginning_in: 366, expected_in: 366,
      location_code: '206B', version: 1, warehouse_id: 'main', discovered: false,
      measured_in: null, measured_at: null, measured_by: null });
    var wo = state.tables.work_orders;
    wo.set('XS024536', { id: 'XS024536', number: 'XS024536', warehouse_id: 'main', status: 'OPEN',
      scheduled_date: dstr(todayD), scheduled_time: '09:00', priority: 'HIGH' });
    wo.set('XS024537', { id: 'XS024537', number: 'XS024537', warehouse_id: 'main', status: 'OPEN',
      scheduled_date: dstr(tomD), scheduled_time: '10:30', priority: 'NORMAL' });
    var lines = state.tables.work_order_material_lines;
    lines.set('XS024536-L1', { id: 'XS024536-L1', work_order_id: 'XS024536', warehouse_id: 'main',
      style: 'Marvel', color: 'Chrome', width_in: 144, material_type: 'carpet', required_in: 237 });
  }
  seed();

  function send(res, code, obj, contentType) {
    var body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': contentType || 'application/json' });
    res.end(body);
  }
  function authed(req) {
    var h = req.headers['authorization'] || '';
    var tok = h.replace(/^Bearer\s+/, '');
    return !!state.sessions[tok];
  }
  function readBody(req) {
    return new Promise(function (resolve) {
      var chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () { resolve(Buffer.concat(chunks)); });
    });
  }
  function parseQuery(q) {
    var filters = {};
    Object.keys(q).forEach(function (k) {
      if (k === 'select' || k === 'order' || k === 'limit' || k === 'offset') return;
      var m = /^(eq|neq|gt|gte|lt|lte|in)\.(.*)$/.exec(q[k] || '');
      if (m) filters[k] = { op: m[1], val: m[2] };
    });
    return filters;
  }
  function applyFilters(rows, q) {
    var f = parseQuery(q);
    var out = rows.filter(function (r) {
      return Object.keys(f).every(function (k) {
        var v = r[k], flt = f[k];
        if (flt.op === 'eq') return String(v) === flt.val;
        if (flt.op === 'neq') return String(v) !== flt.val;
        if (flt.op === 'in') return flt.val.replace(/[()]/g, '').split(',').indexOf(String(v)) >= 0;
        if (flt.op === 'gt') return Number(v) > Number(flt.val);
        if (flt.op === 'gte') return Number(v) >= Number(flt.val);
        if (flt.op === 'lt') return Number(v) < Number(flt.val);
        if (flt.op === 'lte') return Number(v) <= Number(flt.val);
        return true;
      });
    });
    if (q.limit) out = out.slice(0, Number(q.limit));
    return out;
  }
  function errObj(code, message, extra) {
    return { ok: false, error: Object.assign({ code: code, message: message }, extra || {}) };
  }

  /* ---------------- RPCs (atomic, version-checked, idempotent) ---------------- */
  function rpcRecordCut(b) {
    if (b.p_client_request_id && state.idempotency[b.p_client_request_id])
      return Object.assign({ ok: true, duplicate: true }, state.idempotency[b.p_client_request_id]);
    var roll = state.tables.rolls.get(b.p_roll_id);
    if (!roll) return errObj('ROLL_NOT_FOUND', 'Roll does not exist.');
    if (b.p_expected_version != null && b.p_expected_version !== roll.version)
      return errObj('ROLL_VERSION_CONFLICT', 'Roll was updated by another device.',
        { expected_version: b.p_expected_version, current_version: roll.version, current_balance_in: roll.expected_in });
    if (b.p_cut_in > roll.expected_in)
      return errObj('INSUFFICIENT_BALANCE', 'Cut exceeds the current balance.',
        { current_balance_in: roll.expected_in });
    var aid = b.p_assignment_id || null;
    if (aid) {
      var a = state.tables.inventory_assignments.get(aid);
      if (!a || a.status !== 'RESERVED' || a.roll_id !== b.p_roll_id)
        return errObj('ASSIGNMENT_INVALID', 'Assignment is not an active reservation for this roll.');
    }
    var cutId = nid('CT');
    var now = new Date().toISOString();
    state.tables.cut_transactions.set(cutId, {
      id: cutId, roll_id: b.p_roll_id, warehouse_id: b.p_warehouse_id,
      order_number: b.p_order_number, cut_in: b.p_cut_in,
      balance_before_in: roll.expected_in, balance_after_in: roll.expected_in - b.p_cut_in,
      location_code: b.p_location_code, employee_name: b.p_employee_name,
      assignment_id: aid, client_request_id: b.p_client_request_id, at: now
    });
    roll.expected_in -= b.p_cut_in;
    roll.version += 1;
    if (aid) {
      var aa = state.tables.inventory_assignments.get(aid);
      aa.status = 'CONSUMED'; aa.consumed_at = now;
      aa.consumed_by = b.p_employee_name; aa.cut_id = cutId; aa.actual_cut_in = b.p_cut_in;
    }
    state.tables.history_events.set(nid('H'), { id: nid('H'), roll_id: b.p_roll_id,
      warehouse_id: b.p_warehouse_id, event_type: 'CUT_RECORDED',
      employee_name: b.p_employee_name, at: now });
    state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: b.p_warehouse_id,
      action: 'CUT_RECORDED', entity_type: 'cut_transaction', entity_id: cutId, at: now });
    var result = { cut_id: cutId, new_balance_in: roll.expected_in, new_version: roll.version };
    if (b.p_client_request_id) state.idempotency[b.p_client_request_id] = result;
    return Object.assign({ ok: true, duplicate: false }, result);
  }
  function rpcReserveInventory(b) {
    if (b.p_client_request_id && state.idempotency[b.p_client_request_id])
      return Object.assign({ ok: true, duplicate: true }, state.idempotency[b.p_client_request_id]);
    var roll = state.tables.rolls.get(b.p_roll_id);
    if (!roll) return errObj('ROLL_NOT_FOUND', 'Roll does not exist.');
    if (b.p_expected_version != null && b.p_expected_version !== roll.version)
      return errObj('ROLL_VERSION_CONFLICT', 'Roll was updated by another device.',
        { expected_version: b.p_expected_version, current_version: roll.version, current_balance_in: roll.expected_in });
    if (!b.p_reserved_in || b.p_reserved_in <= 0)
      return errObj('INVALID_QUANTITY', 'Reserved quantity must be greater than zero.');
    var aid = nid('AR');
    var now = new Date().toISOString();
    state.tables.inventory_assignments.set(aid, {
      id: aid, work_order_id: b.p_work_order_id, line_id: b.p_line_id, roll_id: b.p_roll_id,
      warehouse_id: b.p_warehouse_id, reserved_in: b.p_reserved_in, status: 'RESERVED',
      employee_name: b.p_employee_name, location_code: b.p_location_code,
      mismatch_approved_by: b.p_mismatch_approved_by || null,
      over_approved_by: b.p_over_approved_by || null,
      created_at: now
    });
    state.tables.history_events.set(nid('H'), { id: nid('H'), roll_id: b.p_roll_id,
      warehouse_id: b.p_warehouse_id, event_type: 'INVENTORY_ASSIGNED',
      employee_name: b.p_employee_name, at: now });
    var result = { assignment_id: aid, roll_version: roll.version };
    if (b.p_client_request_id) state.idempotency[b.p_client_request_id] = result;
    return Object.assign({ ok: true, duplicate: false }, result);
  }
  function rpcRecordCycleCount(b) {
    var roll = state.tables.rolls.get(b.p_roll_id);
    if (!roll) return errObj('ROLL_NOT_FOUND', 'Roll does not exist.');
    var recId = nid('C');
    var now = new Date().toISOString();
    var diff = b.p_measured_in - b.p_expected_in;
    state.tables.cycle_count_records.set(recId, {
      id: recId, session_id: b.p_session_id || null, roll_id: b.p_roll_id,
      warehouse_id: b.p_warehouse_id, location_code: b.p_location_code,
      expected_in: b.p_expected_in, measured_in: b.p_measured_in, diff_in: diff,
      status: b.p_status, measured: true, employee_name: b.p_employee_name,
      note: b.p_note || null, at: now
    });
    /* MB stamp — expected_in and version untouched (mirrors the real RPC). */
    roll.measured_in = b.p_measured_in; roll.measured_at = now; roll.measured_by = b.p_employee_name;
    state.tables.history_events.set(nid('H'), { id: nid('H'), roll_id: b.p_roll_id,
      warehouse_id: b.p_warehouse_id, event_type: 'PHYSICAL_MEASUREMENT',
      employee_name: b.p_employee_name, at: now });
    state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: b.p_warehouse_id,
      action: 'CYCLE_COUNT_RECORDED', entity_type: 'cycle_count_record', entity_id: recId, at: now });
    return { ok: true, record_id: recId, diff_in: diff, roll_version: roll.version };
  }

  /* ---- Run 6: order -> sales order / line -> work order (atomic RPCs) ---- */
  /* Idempotency: same order id or same line id never creates a duplicate. */
  /* Atomic order creation: number issued inside the same step, idempotent on order id. */
  function rpcCreateOrder(b) {
    var orders = state.tables.orders;
    var now = new Date().toISOString();
    var existing = orders.get(b.p_order_id);
    if (existing) return { ok: true, duplicate: true, order_id: existing.id, number: existing.number };
    var num = issueNum('ORD', 'ord-num:' + b.p_order_id);
    var o = { id: b.p_order_id, number: num, warehouse_id: b.p_warehouse_id,
      property: b.p_property, account: b.p_account || null,
      requested_date: b.p_requested_date || null, scheduled_date: b.p_scheduled_date || null,
      priority: b.p_priority || 'NORMAL', created_by: b.p_created_by || null,
      internal_ref: b.p_internal_ref || null, notes: b.p_notes || null,
      status: 'DRAFT', sales_order_id: null, submitted_at: null,
      created_at: now, updated_at: now };
    orders.set(o.id, o);
    return { ok: true, duplicate: false, order_id: o.id, number: num };
  }
  function rpcSubmitSalesOrder(b) {
    var orders = state.tables.orders, items = state.tables.order_items;
    var sos = state.tables.sales_orders, solines = state.tables.sales_order_lines;
    var now = new Date().toISOString();
    var o = orders.get(b.p_order_id);
    if (!o) return errObj('ORDER_NOT_FOUND', 'Order does not exist.');
    if (o.sales_order_id) {
      var existing = sos.get(o.sales_order_id);
      if (existing) return { ok: true, duplicate: true, sales_order_id: existing.id, number: existing.number };
    }
    if (o.status !== 'DRAFT' && o.status !== 'READY_FOR_REVIEW')
      return errObj('ORDER_NOT_SUBMITTABLE', 'Order is not in a submittable state.', { status: o.status });
    var its = Array.from(items.values()).filter(function (i) { return i.order_id === o.id; })
      .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
    if (!its.length) return errObj('ORDER_HAS_NO_ITEMS', 'Order has no items.');
    var soId = b.p_sales_order_id || nid('SO');
    var so = { id: soId, number: b.p_number || issueNum('SO', 'so-num:' + soId), source_order_id: o.id, warehouse_id: o.warehouse_id,
      property: o.property, account: o.account, priority: o.priority,
      requested_date: o.requested_date, scheduled_date: o.scheduled_date,
      status: 'OPEN', created_by: o.created_by, submitted_by: b.p_submitted_by || null,
      notes: o.notes, on_hold: false, hold_reason: null, hold_at: null, hold_by: null,
      created_at: now, submitted_at: now, updated_at: now };
    sos.set(soId, so);
    its.forEach(function (it, n) {
      var lid = nid('SOL');
      solines.set(lid, { id: lid, sales_order_id: soId, seq: n + 1, source_item_id: it.id,
        style: it.style, color: it.color, material_type: it.material_type, uom: it.uom,
        width_in: it.width_in,
        ordered_in: it.quantity_in, ordered_qty: it.quantity,
        warehouse_qty_required: it.quantity_in != null ? it.quantity_in : it.quantity,
        status: 'OPEN', work_order_id: null });
    });
    o.status = 'SUBMITTED'; o.sales_order_id = soId; o.submitted_at = now; o.updated_at = now;
    state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: o.warehouse_id,
      action: 'ORDER_SUBMITTED', entity_type: 'order', entity_id: o.id,
      new_value: JSON.stringify({ sales_order_id: soId, number: so.number }), created_at: now });
    return { ok: true, duplicate: false, sales_order_id: soId, number: so.number };
  }
  function rpcReleaseSalesOrderLine(b) {
    var sos = state.tables.sales_orders, solines = state.tables.sales_order_lines;
    var wos = state.tables.work_orders, wolines = state.tables.work_order_material_lines;
    var now = new Date().toISOString();
    var l = solines.get(b.p_line_id);
    if (!l) return errObj('LINE_NOT_FOUND', 'Sales order line does not exist.');
    var so = sos.get(l.sales_order_id);
    if (!so) return errObj('SALES_ORDER_NOT_FOUND', 'Sales order does not exist.');
    /* Mirrors the real RPC ordering: hold/cancel is checked before the
       idempotent-release path (fail-closed). */
    if (so.on_hold || so.status === 'CANCELLED')
      return errObj('SALES_ORDER_NOT_RELEASABLE', 'Sales order is not releasable.');
    if (l.status === 'RELEASED' && l.work_order_id) {
      var existing = wos.get(l.work_order_id);
      if (existing) return { ok: true, duplicate: true, work_order_id: existing.id, number: existing.number };
    }
    if (l.status !== 'OPEN')
      return errObj('LINE_NOT_OPEN', 'Line is not open for release.', { status: l.status });
    var woId = b.p_work_order_id || nid('WO');
    var wo = { id: woId, number: b.p_wo_number || issueNum('WO', 'wo-num:' + woId), warehouse_id: so.warehouse_id,
      property: so.property, account: so.account, status: 'OPEN',
      assignment_status: 'UNASSIGNED', assignee_id: null,
      scheduled_date: so.scheduled_date, scheduled_time: null, priority: so.priority,
      on_hold: false, hold_reason: null, hold_at: null, hold_by: null,
      warehouse_completed_at: null, warehouse_completed_by: null,
      sales_order_id: so.id, sales_order_line_id: l.id,
      notes: 'Generated from ' + so.number + ' line ' + l.seq + '.',
      created_at: now };
    wos.set(woId, wo);
    var wlId = nid('WOL');
    wolines.set(wlId, { id: wlId, work_order_id: woId, warehouse_id: so.warehouse_id,
      style: b.p_style, color: b.p_color, material_type: b.p_material_type, uom: b.p_uom,
      width_in: b.p_width_in, required_in: b.p_required_in, required_count: b.p_required_count });
    l.status = 'RELEASED'; l.work_order_id = woId;
    /* SO status rollup. */
    var all = Array.from(solines.values()).filter(function (x) { return x.sales_order_id === so.id; });
    var rel = all.filter(function (x) { return x.status === 'RELEASED'; }).length;
    if (rel === all.length && all.length) so.status = 'RELEASED_TO_WAREHOUSE';
    else if (rel > 0) so.status = 'PARTIALLY_RELEASED';
    state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: so.warehouse_id,
      action: 'SALES_ORDER_LINE_RELEASED', entity_type: 'sales_order', entity_id: so.id,
      related_work_order_id: woId, new_value: JSON.stringify({ line_id: l.id }), created_at: now });
    return { ok: true, duplicate: false, work_order_id: woId, number: wo.number };
  }

/* ---- Run 7: central numbering + loadout + receipts ---- */
function rpcIssueBusinessNumber(b) {
  var key = b.p_request_key;
  if (key && state.idempotency['num:' + key]) {
    var prev = state.idempotency['num:' + key];
    return { ok: true, duplicate: true, number: prev.number };
  }
  var ctr = state.tables.business_number_counters.get(b.p_kind);
  if (!ctr) return errObj('UNKNOWN_NUMBER_KIND', 'Unknown number kind.');
  var issued = ctr.prefix + ctr.next_val;
  ctr.next_val += 1;
  if (key) state.idempotency['num:' + key] = { number: issued };
  return { ok: true, duplicate: false, number: issued };
}
function issueNum(kind, key) {
  return rpcIssueBusinessNumber({ p_kind: kind, p_request_key: key }).number;
}
function rpcStartLoadout(b) {
  var wos = state.tables.work_orders, los = state.tables.loadouts, lls = state.tables.loadout_lines;
  var now = new Date().toISOString();
  var w = wos.get(b.p_work_order_id);
  if (!w) return errObj('WORK_ORDER_NOT_FOUND', 'Work order does not exist.');
  if (b.p_request_key) {
    var byKey = Array.from(los.values()).filter(function (l) { return l.client_request_key === b.p_request_key; })[0];
    if (byKey) return { ok: true, duplicate: true, loadout_id: byKey.id, number: byKey.number };
  }
  var open = Array.from(los.values()).filter(function (l) {
    return l.work_order_id === w.id && ['READY', 'IN_PROGRESS', 'LOADED'].indexOf(l.status) >= 0;
  })[0];
  if (open) return { ok: true, duplicate: true, loadout_id: open.id, number: open.number };
  /* Authoritative readiness: every material line needs a CONSUMED assignment. */
  var mlines = Array.from(state.tables.work_order_material_lines.values())
    .filter(function (l) { return l.work_order_id === w.id; });
  var notReady = mlines.filter(function (ml) {
    return !Array.from(state.tables.inventory_assignments.values()).some(function (a) {
      return a.work_order_id === w.id && a.line_id === ml.id && a.status === 'CONSUMED';
    });
  });
  if (notReady.length) return errObj('LOADOUT_NOT_READY', 'Not all material lines are cut.');
  var num = issueNum('LOAD', 'load-num:' + b.p_loadout_id);
  var lo = { id: b.p_loadout_id, number: num, work_order_id: w.id,
    sales_order_id: w.sales_order_id || null, warehouse_id: w.warehouse_id,
    property: w.property, account: w.account, status: 'READY',
    priority: w.priority || 'NORMAL',
    started_by: b.p_by, started_at: now, completed_by: null, completed_at: null,
    on_hold: false, hold_reason: null, notes: null,
    client_request_key: b.p_request_key || null, created_at: now, updated_at: now };
  los.set(lo.id, lo);
  (b.p_lines || []).forEach(function (ln, i) {
    var lid = lo.id + '-L' + (i + 1);
    lls.set(lid, { id: lid, loadout_id: lo.id, seq: i + 1,
      style: ln.style || null, color: ln.color || null, material_type: ln.material_type || null,
      uom: ln.uom || null, width_in: ln.width_in || null,
      required_in: ln.required_in || null, required_count: ln.required_count || null,
      prepared_in: ln.prepared_in || null, roll_id: ln.roll_id || null, barcode: ln.barcode || null,
      status: 'WAITING', verified_by: null, verified_at: null,
      loaded_by: null, loaded_at: null, created_at: now });
  });
  state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: w.warehouse_id,
    action: 'LOADOUT_STARTED', entity_type: 'loadout', entity_id: lo.id,
    related_work_order_id: w.id, user_name: b.p_by, created_at: now });
  return { ok: true, duplicate: false, loadout_id: lo.id, number: num };
}
function rpcBeginLoadoutLoading(b) {
  var lo = state.tables.loadouts.get(b.p_loadout_id);
  if (!lo) return errObj('LOADOUT_NOT_FOUND', 'Loadout does not exist.');
  if (lo.status === 'IN_PROGRESS') return { ok: true, duplicate: true };
  if (lo.status !== 'READY') return errObj('INVALID_STATUS', 'Loadout is not ready.');
  lo.status = 'IN_PROGRESS'; lo.updated_at = new Date().toISOString();
  state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: lo.warehouse_id,
    action: 'LOADOUT_LOADING_BEGUN', entity_type: 'loadout', entity_id: lo.id,
    related_work_order_id: lo.work_order_id, user_name: b.p_by, created_at: lo.updated_at });
  return { ok: true, duplicate: false };
}
function rpcVerifyLoadoutLine(b) {
  var lo = state.tables.loadouts.get(b.p_loadout_id);
  if (!lo) return errObj('LOADOUT_NOT_FOUND', 'Loadout does not exist.');
  if (lo.status === 'COMPLETED') return errObj('LOADOUT_COMPLETED', 'Loadout is completed.');
  var ln = state.tables.loadout_lines.get(b.p_line_id);
  if (!ln || ln.loadout_id !== lo.id) return errObj('LINE_NOT_FOUND', 'Line does not exist.');
  if (ln.status === 'VERIFIED') return { ok: true, duplicate: true };
  if (['WAITING', 'EXCEPTION'].indexOf(ln.status) < 0)
    return errObj('INVALID_STATUS', 'Line cannot be verified.');
  var now = new Date().toISOString();
  var want = String(ln.barcode || '').trim().toUpperCase();
  var got = String(b.p_barcode || '').trim().toUpperCase();
  if (want && want === got) {
    ln.status = 'VERIFIED'; ln.verified_by = b.p_by; ln.verified_at = now;
    state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: lo.warehouse_id,
      action: 'LOADOUT_LINE_VERIFIED', entity_type: 'loadout', entity_id: lo.id,
      related_work_order_id: lo.work_order_id, user_name: b.p_by, created_at: now });
    return { ok: true, duplicate: false };
  }
  state.tables.loadout_exceptions.set(nid('LE'), { id: nid('LE'), loadout_id: lo.id,
    line_id: ln.id, type: 'WRONG MATERIAL',
    notes: 'Scanned ' + b.p_barcode + ', expected ' + (ln.barcode || '—') + '.',
    created_by: b.p_by, created_at: now });
  ln.status = 'EXCEPTION';
  state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: lo.warehouse_id,
    action: 'LOADOUT_EXCEPTION', entity_type: 'loadout', entity_id: lo.id,
    related_work_order_id: lo.work_order_id, user_name: b.p_by, created_at: now });
  return { ok: true, wrong_material: true };
}
function rpcMarkLoadoutLineLoaded(b) {
  var lo = state.tables.loadouts.get(b.p_loadout_id);
  if (!lo) return errObj('LOADOUT_NOT_FOUND', 'Loadout does not exist.');
  var ln = state.tables.loadout_lines.get(b.p_line_id);
  if (!ln || ln.loadout_id !== lo.id) return errObj('LINE_NOT_FOUND', 'Line does not exist.');
  if (ln.status === 'LOADED') return { ok: true, duplicate: true };
  if (ln.status !== 'VERIFIED') return errObj('LINE_NOT_VERIFIED', 'Line must be verified first.');
  var now = new Date().toISOString();
  ln.status = 'LOADED'; ln.loaded_by = b.p_by; ln.loaded_at = now;
  var rest = Array.from(state.tables.loadout_lines.values())
    .filter(function (l) { return l.loadout_id === lo.id && l.status !== 'LOADED'; });
  lo.status = rest.length ? 'IN_PROGRESS' : 'LOADED';
  lo.updated_at = now;
  state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: lo.warehouse_id,
    action: 'LOADOUT_LINE_LOADED', entity_type: 'loadout', entity_id: lo.id,
    related_work_order_id: lo.work_order_id, user_name: b.p_by, created_at: now });
  return { ok: true, duplicate: false };
}
function rpcCreateLoadoutException(b) {
  var lo = state.tables.loadouts.get(b.p_loadout_id);
  if (!lo) return errObj('LOADOUT_NOT_FOUND', 'Loadout does not exist.');
  var now = new Date().toISOString();
  state.tables.loadout_exceptions.set(nid('LE'), { id: nid('LE'), loadout_id: lo.id,
    line_id: b.p_line_id || null, type: b.p_type, notes: b.p_notes || null,
    created_by: b.p_by, created_at: now });
  if (b.p_line_id) {
    var ln = state.tables.loadout_lines.get(b.p_line_id);
    if (ln && ln.loadout_id === lo.id) ln.status = 'EXCEPTION';
  }
  return { ok: true };
}
function rpcCompleteLoadout(b) {
  var lo = state.tables.loadouts.get(b.p_loadout_id);
  if (!lo) return errObj('LOADOUT_NOT_FOUND', 'Loadout does not exist.');
  if (lo.status === 'COMPLETED') return { ok: true, duplicate: true };
  var pending = Array.from(state.tables.loadout_lines.values())
    .filter(function (l) { return l.loadout_id === lo.id && l.status !== 'LOADED'; });
  if (pending.length) return errObj('LOADOUT_INCOMPLETE', 'Not all lines are loaded.');
  var now = new Date().toISOString();
  lo.status = 'COMPLETED'; lo.completed_by = b.p_by; lo.completed_at = now; lo.updated_at = now;
  state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: lo.warehouse_id,
    action: 'LOADOUT_COMPLETED', entity_type: 'loadout', entity_id: lo.id,
    related_work_order_id: lo.work_order_id, user_name: b.p_by, created_at: now });
  return { ok: true, duplicate: false };
}
function rpcCreateReceipt(b) {
  var rs = state.tables.receipts;
  var now = new Date().toISOString();
  if (b.p_request_key) {
    var byKey = Array.from(rs.values()).filter(function (r) { return r.client_request_key === b.p_request_key; })[0];
    if (byKey) return { ok: true, duplicate: true, receipt_id: byKey.id, number: byKey.number };
  }
  var num = issueNum('RCV', 'rcv-num:' + b.p_receipt_id);
  var r = { id: b.p_receipt_id, number: num, warehouse_id: 'main',
    supplier: b.p_supplier || null, reference_number: b.p_reference || null,
    status: b.p_expected ? 'EXPECTED' : 'RECEIVING', expected_date: null,
    notes: b.p_notes || null, created_by: b.p_by, created_at: now,
    completed_by: null, completed_at: null, client_request_key: b.p_request_key || null };
  rs.set(r.id, r);
  state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: 'main',
    action: 'RECEIPT_CREATED', entity_type: 'receipt', entity_id: r.id,
    user_name: b.p_by, created_at: now });
  return { ok: true, duplicate: false, receipt_id: r.id, number: num };
}
function rpcAddReceiptLine(b) {
  var rs = state.tables.receipts, rls = state.tables.receipt_lines;
  var now = new Date().toISOString();
  var r = rs.get(b.p_receipt_id);
  if (!r) return errObj('RECEIPT_NOT_FOUND', 'Receipt does not exist.');
  if (r.status === 'RECEIVED') return errObj('RECEIPT_COMPLETED', 'Receipt is completed.');
  if (b.p_request_key) {
    var byKey = Array.from(rls.values()).filter(function (l) { return l.client_request_key === b.p_request_key; })[0];
    if (byKey) return { ok: true, duplicate: true, line_id: byKey.id };
  }
  var seq = Array.from(rls.values()).filter(function (l) { return l.receipt_id === r.id; }).length + 1;
  var l = { id: b.p_line_id, receipt_id: r.id, seq: seq,
    material_type: b.p_material_type || null, uom: b.p_uom || null,
    style: b.p_style || null, color: b.p_color || null, manufacturer: null,
    width_in: null, expected_qty_in: b.p_expected_qty_in || null,
    expected_qty: b.p_expected_qty || null, received_qty_in: null, received_qty: null,
    roll_id: null, barcode: null, location_code: null, status: 'EXPECTED',
    exception: null, received_by: null, received_at: null,
    client_request_key: b.p_request_key || null };
  rls.set(l.id, l);
  if (r.status === 'EXPECTED') r.status = 'RECEIVING';
  return { ok: true, duplicate: false, line_id: l.id };
}
function rpcReceiveRoll(b) {
  var rs = state.tables.receipts, rls = state.tables.receipt_lines, rolls = state.tables.rolls;
  var now = new Date().toISOString();
  var r = rs.get(b.p_receipt_id);
  if (!r) return errObj('RECEIPT_NOT_FOUND', 'Receipt does not exist.');
  if (r.status === 'RECEIVED') return errObj('RECEIPT_COMPLETED', 'Receipt is completed.');
  if (b.p_request_key) {
    var byKey = Array.from(rls.values()).filter(function (l) { return l.client_request_key === b.p_request_key; })[0];
    if (byKey) return { ok: true, duplicate: true, line_id: byKey.id, roll_id: byKey.roll_id };
  }
  if (!b.p_length_in || b.p_length_in <= 0)
    return errObj('INVALID_QUANTITY', 'Length must be greater than zero.');
  var want = String(b.p_barcode || '').trim().toUpperCase();
  var dup = Array.from(rolls.values()).filter(function (x) {
    return String(x.barcode || '').trim().toUpperCase() === want && x.warehouse_id === r.warehouse_id;
  })[0];
  if (dup) {
    if (!b.p_override) return errObj('ROLL_ALREADY_EXISTS', 'ROLL ALREADY EXISTS');
    state.tables.receipt_exceptions.set(nid('RE'), { id: nid('RE'), receipt_id: r.id,
      line_id: null, type: 'DUPLICATE ROLL',
      notes: 'Barcode ' + b.p_barcode + ' already exists as roll ' + dup.id + '.',
      created_by: b.p_by, created_at: now });
    return { ok: true, duplicate_roll: true, roll_id: dup.id };
  }
  var roll = { id: b.p_roll_id, barcode: b.p_barcode, warehouse_id: r.warehouse_id,
    manufacturer: b.p_manufacturer || null, style: b.p_style || null, color: b.p_color || null,
    material_type: 'carpet', width_in: b.p_width_in || null,
    beginning_in: b.p_length_in, expected_in: b.p_length_in,
    location_code: b.p_location_code || null, version: 1,
    measured_in: null, measured_at: null, measured_by: null, discovered: false };
  rolls.set(roll.id, roll);
  var seq = Array.from(rls.values()).filter(function (l) { return l.receipt_id === r.id; }).length + 1;
  var l = { id: b.p_line_id, receipt_id: r.id, seq: seq,
    material_type: 'CARPET', uom: 'LF', style: b.p_style || null, color: b.p_color || null,
    manufacturer: b.p_manufacturer || null, width_in: b.p_width_in || null,
    expected_qty_in: null, expected_qty: null,
    received_qty_in: b.p_length_in, received_qty: null,
    roll_id: roll.id, barcode: b.p_barcode, location_code: b.p_location_code || null,
    status: 'RECEIVED', exception: null, received_by: b.p_by, received_at: now,
    client_request_key: b.p_request_key || null };
  rls.set(l.id, l);
  if (r.status === 'EXPECTED') r.status = 'RECEIVING';
  state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: r.warehouse_id,
    action: 'ROLL_RECEIVED', entity_type: 'receipt', entity_id: r.id,
    user_name: b.p_by, created_at: now });
  return { ok: true, duplicate: false, line_id: l.id, roll_id: roll.id };
}
function rpcCreateReceiptException(b) {
  var r = state.tables.receipts.get(b.p_receipt_id);
  if (!r) return errObj('RECEIPT_NOT_FOUND', 'Receipt does not exist.');
  var now = new Date().toISOString();
  state.tables.receipt_exceptions.set(nid('RE'), { id: nid('RE'), receipt_id: r.id,
    line_id: b.p_line_id || null, type: b.p_type, notes: b.p_notes || null,
    created_by: b.p_by, created_at: now });
  if (b.p_line_id) {
    var l = state.tables.receipt_lines.get(b.p_line_id);
    if (l && l.receipt_id === r.id) { l.status = 'EXCEPTION'; l.exception = b.p_type; }
  }
  if (r.status !== 'RECEIVED') r.status = 'EXCEPTIONS';
  return { ok: true };
}
function rpcCompleteReceipt(b) {
  var r = state.tables.receipts.get(b.p_receipt_id);
  if (!r) return errObj('RECEIPT_NOT_FOUND', 'Receipt does not exist.');
  if (r.status === 'RECEIVED') return { ok: true, duplicate: true };
  var n = Array.from(state.tables.receipt_lines.values())
    .filter(function (l) { return l.receipt_id === r.id; }).length;
  if (!n) return errObj('RECEIPT_HAS_NO_LINES', 'Receipt has no lines.');
  var now = new Date().toISOString();
  r.status = 'RECEIVED'; r.completed_by = b.p_by; r.completed_at = now;
  state.tables.audit_events.set(nid('A'), { id: nid('A'), warehouse_id: r.warehouse_id,
    action: 'RECEIPT_COMPLETED', entity_type: 'receipt', entity_id: r.id,
    user_name: b.p_by, created_at: now });
  return { ok: true, duplicate: false };
}

  var server = http.createServer(function (req, res) {
    var parsed = url.parse(req.url, true);
    var p = parsed.path;
    readBody(req).then(function (buf) {
      var body = null;
      try { body = buf.length ? JSON.parse(buf.toString()) : null; } catch (e) { body = null; }

      /* ---- Auth ---- */
      if (p.indexOf('/auth/v1/token') === 0 && req.method === 'POST') {
        if (!body || !body.email) return send(res, 400, { error: 'email required' });
        var tok = 'test-token-' + (++seq);
        state.sessions[tok] = { email: body.email };
        return send(res, 200, { access_token: tok, token_type: 'bearer', user: { email: body.email } });
      }
      if (p.indexOf('/auth/v1/logout') === 0) {
        var h = req.headers['authorization'] || '';
        delete state.sessions[h.replace(/^Bearer\s+/, '')];
        return send(res, 204, '');
      }

      /* ---- Storage ---- */
      var sm = /^\/storage\/v1\/object\/(history-cards)\/(.+)$/.exec(parsed.pathname);
      if (sm) {
        var key = sm[1] + '/' + sm[2];
        if (req.method === 'POST' || req.method === 'PUT') {
          if (!authed(req)) return send(res, 401, { message: 'auth required' });
          /* No update policy: an existing object can never be overwritten. */
          if (state.storage[key]) return send(res, 409, { message: 'object exists' });
          state.storage[key] = buf;
          return send(res, 200, { Key: key });
        }
        if (req.method === 'GET') {
          if (!authed(req)) return send(res, 401, { message: 'auth required' });
          if (!state.storage[key]) return send(res, 404, { message: 'not found' });
          return send(res, 200, state.storage[key], 'image/jpeg');
        }
        if (req.method === 'DELETE') {
          if (!authed(req)) return send(res, 401, { code: 'PGRST301', message: 'auth required' });
          var delMatched = applyFilters(Array.from(table.values()), parsed.query);
          delMatched.forEach(function (row) { table.delete(row.id); });
          return send(res, 200, delMatched);
        }
        return send(res, 405, { message: 'method not allowed' });
      }

      /* ---- RPC ---- */
      var rm = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(parsed.pathname);
      if (rm && req.method === 'POST') {
        if (!authed(req)) return send(res, 401, { code: 'PGRST301', message: 'auth required' });
        var out;
        if (rm[1] === 'record_cut') out = rpcRecordCut(body || {});
        else if (rm[1] === 'reserve_inventory') out = rpcReserveInventory(body || {});
        else if (rm[1] === 'record_cycle_count') out = rpcRecordCycleCount(body || {});
        else if (rm[1] === 'create_order') out = rpcCreateOrder(body || {});
        else if (rm[1] === 'submit_sales_order') out = rpcSubmitSalesOrder(body || {});
        else if (rm[1] === 'release_sales_order_line') out = rpcReleaseSalesOrderLine(body || {});
        else if (rm[1] === 'issue_business_number') out = rpcIssueBusinessNumber(body || {});
        else if (rm[1] === 'start_loadout') out = rpcStartLoadout(body || {});
        else if (rm[1] === 'begin_loadout_loading') out = rpcBeginLoadoutLoading(body || {});
        else if (rm[1] === 'verify_loadout_line') out = rpcVerifyLoadoutLine(body || {});
        else if (rm[1] === 'mark_loadout_line_loaded') out = rpcMarkLoadoutLineLoaded(body || {});
        else if (rm[1] === 'create_loadout_exception') out = rpcCreateLoadoutException(body || {});
        else if (rm[1] === 'complete_loadout') out = rpcCompleteLoadout(body || {});
        else if (rm[1] === 'create_receipt') out = rpcCreateReceipt(body || {});
        else if (rm[1] === 'add_receipt_line') out = rpcAddReceiptLine(body || {});
        else if (rm[1] === 'receive_roll') out = rpcReceiveRoll(body || {});
        else if (rm[1] === 'create_receipt_exception') out = rpcCreateReceiptException(body || {});
        else if (rm[1] === 'complete_receipt') out = rpcCompleteReceipt(body || {});
        else return send(res, 404, { message: 'unknown rpc' });
        return send(res, 200, out);
      }

      /* ---- Tables ---- */
      var tm = /^\/rest\/v1\/([a-z_]+)$/.exec(parsed.pathname);
      if (tm && state.tables[tm[1]]) {
        var table = state.tables[tm[1]];
        if (req.method === 'GET') {
          return send(res, 200, applyFilters(Array.from(table.values()), parsed.query));
        }
        if (req.method === 'POST') {
          if (!authed(req)) return send(res, 401, { code: 'PGRST301', message: 'auth required' });
          var rows = Array.isArray(body) ? body : [body];
          rows.forEach(function (r) {
            if (tm[1] === 'rolls' && r.version == null) r.version = 1; /* DB default */
            if (tm[1] === 'rolls' && r.expected_in == null) r.expected_in = r.beginning_in || 0;
            table.set(r.id, r);
          });
          return send(res, 201, rows);
        }
        if (req.method === 'PATCH') {
          if (!authed(req)) return send(res, 401, { code: 'PGRST301', message: 'auth required' });
          var matched = applyFilters(Array.from(table.values()), parsed.query);
          /* Transition guard is assignment-specific; orders / sales orders /
             work orders manage their own lifecycle server-side. */
          var LEGAL = (tm[1] === 'inventory_assignments') ? { RESERVED: ['RELEASED', 'CONSUMED'] } : null;
          for (var i = 0; i < matched.length; i++) {
            var row = matched[i];
            if (body && body.status && row.status && body.status !== row.status && LEGAL) {
              var legal = LEGAL[row.status] || [];
              if (legal.indexOf(body.status) < 0)
                return send(res, 400, { message: 'Illegal assignment transition ' + row.status + ' -> ' + body.status });
            }
            Object.keys(body || {}).forEach(function (k) { row[k] = body[k]; });
          }
          return send(res, 200, matched);
        }
        return send(res, 405, { message: 'method not allowed' });
      }
      return send(res, 404, { message: 'not found: ' + parsed.pathname });
    });
  });

  return {
    state: state,
    start: function () {
      return new Promise(function (resolve) {
        server.listen(0, '127.0.0.1', function () {
          resolve('http://127.0.0.1:' + server.address().port);
        });
      });
    },
    close: function () { return new Promise(function (r) { server.close(r); }); }
  };
}

module.exports = { startDouble: startDouble, TABLES: TABLES };
