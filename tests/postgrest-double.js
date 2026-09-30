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
  'audit_events'
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
    wo.set('XS024536', { id: 'XS024536', number: 'XS024536', warehouse_id: 'main', status: 'OPEN' });
    wo.set('XS024537', { id: 'XS024537', number: 'XS024537', warehouse_id: 'main', status: 'OPEN' });
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
          var LEGAL = { RESERVED: ['RELEASED', 'CONSUMED'] };
          for (var i = 0; i < matched.length; i++) {
            var row = matched[i];
            if (body && body.status && row.status && body.status !== row.status) {
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
