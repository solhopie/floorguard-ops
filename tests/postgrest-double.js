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
  'orders', 'order_items', 'sales_orders', 'sales_order_lines'
];

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
    var so = { id: soId, number: b.p_number, source_order_id: o.id, warehouse_id: o.warehouse_id,
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
    var wo = { id: woId, number: b.p_wo_number, warehouse_id: so.warehouse_id,
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
        else if (rm[1] === 'submit_sales_order') out = rpcSubmitSalesOrder(body || {});
        else if (rm[1] === 'release_sales_order_line') out = rpcReleaseSalesOrderLine(body || {});
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
