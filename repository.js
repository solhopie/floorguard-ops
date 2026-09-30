/* ============================================================================
   FloorGuard Ops — Run 4: data provider layer
   ----------------------------------------------------------------------------
   ONE interface, TWO providers:

     LocalFloorGuardRepository   existing localStorage architecture (default)
     SharedFloorGuardRepository  Supabase-compatible backend (PostgREST +
                                 Storage REST) for multi-device sync

   UI code talks to `Repository` (the facade) or the `SharedFlow` helpers.
   Nothing in the UI touches fetch/PostgREST directly, so the backend/hosting
   provider can change later without touching screens.

   DATA_PROVIDER=local   -> Local Demo   (single device, localStorage)
   DATA_PROVIDER=shared  -> Shared Pilot (Supabase Postgres + storage)

   This file must load BEFORE app.js and must not touch app.js globals at
   load time — every delegation resolves them lazily at call time, so the
   Run 1-3 test harnesses (which load only app.js) are unaffected.
   ========================================================================== */

/* ---------------- errors ---------------- */
function RepoError(code, message, data) {
  var e = new Error(message || code);
  e.name = 'RepoError';
  e.code = code;
  e.data = data || null;
  return e;
}
/* Error codes used across the provider layer:
   OFFLINE, NETWORK, NOT_CONFIGURED, NOT_AUTHENTICATED, WAREHOUSE_FORBIDDEN,
   ROLL_VERSION_CONFLICT, INSUFFICIENT_BALANCE, INVALID_CUT, INVALID_QUANTITY,
   ROLL_NOT_FOUND, HTTP_4xx/5xx */

/* ---------------- tiny utils ---------------- */
function rid(prefix) {
  /* Random idempotent request / record id. Not a UUID lib; good enough for
     client request keys and local record ids. */
  var h = function () { return Math.floor(Math.random() * 0xffffffff).toString(16).toUpperCase(); };
  return (prefix || 'R') + Date.now().toString(36).toUpperCase() + h() + h();
}
function isoNow() { return new Date().toISOString(); }
function isOnline() {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}
function lsGet(k) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(k);
  } catch (e) { return null; }
}
function lsSet(k, v) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); } catch (e) {}
}

/* ---------------- configuration ----------------
   Resolution order: window.FLOORGUARD_CONFIG (build-time) ->
   localStorage 'floorguard_ops_cfg' (Settings UI) -> defaults.
   Secrets are NEVER hard-coded here; in the pilot the owner pastes the
   Supabase URL + anon key into Settings (stored on-device only). The
   service-role key is never requested and must never be entered. */
var FG_CFG_KEY = 'floorguard_ops_cfg';
function readProviderConfig() {
  var cfg = { dataProvider: 'local', supabaseUrl: '', supabaseAnonKey: '', warehouseId: 'main' };
  try {
    var w = (typeof window !== 'undefined') ? window.FLOORGUARD_CONFIG : null;
    if (w) {
      if (w.DATA_PROVIDER) cfg.dataProvider = String(w.DATA_PROVIDER).toLowerCase();
      if (w.SUPABASE_URL) cfg.supabaseUrl = String(w.SUPABASE_URL).replace(/\/+$/, '');
      if (w.SUPABASE_ANON_KEY) cfg.supabaseAnonKey = String(w.SUPABASE_ANON_KEY);
    }
    var raw = lsGet(FG_CFG_KEY);
    if (raw) {
      var s = JSON.parse(raw);
      if (s.dataProvider) cfg.dataProvider = String(s.dataProvider).toLowerCase();
      if (s.supabaseUrl) cfg.supabaseUrl = String(s.supabaseUrl).replace(/\/+$/, '');
      if (s.supabaseAnonKey) cfg.supabaseAnonKey = String(s.supabaseAnonKey);
      if (s.warehouseId) cfg.warehouseId = String(s.warehouseId);
    }
  } catch (e) { /* corrupted config -> defaults */ }
  return cfg;
}
function writeProviderConfig(patch) {
  var cfg = readProviderConfig();
  Object.keys(patch || {}).forEach(function (k) { cfg[k] = patch[k]; });
  lsSet(FG_CFG_KEY, JSON.stringify({
    dataProvider: cfg.dataProvider, supabaseUrl: cfg.supabaseUrl,
    supabaseAnonKey: cfg.supabaseAnonKey, warehouseId: cfg.warehouseId
  }));
  return cfg;
}

/* ---------------- auth session (shared mode, pilot) ----------------
   Supabase Auth email+password sign-in. The access token is sent as the
   PostgREST Bearer so RLS sees auth.uid() -> users.auth_user_id.
   Stored on-device only (pilot convenience, not a vault). */
var FG_SESS_KEY = 'floorguard_ops_session';
function readSession() {
  try {
    var raw = lsGet(FG_SESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function writeSession(s) { lsSet(FG_SESS_KEY, s ? JSON.stringify(s) : ''); if (!s) { try { localStorage.removeItem(FG_SESS_KEY); } catch (e) {} } }

/* ---------------- Sync state + offline outbox ---------------- */
var Sync = {
  /* SYNCED | SYNCING | OFFLINE | SYNC_ERROR  (local mode reports SYNCED:
     there is nothing to sync — the device IS the dataset) */
  state: 'SYNCED',
  _listeners: [],
  set: function (s) {
    if (this.state === s) return;
    this.state = s;
    this._listeners.forEach(function (fn) { try { fn(s); } catch (e) {} });
  },
  onChange: function (fn) { this._listeners.push(fn); },
  /* Offline outbox: balance-changing work is NEVER silently retried.
     Items wait here until the worker explicitly taps RETRY; cuts carry
     their idempotency key so a retry can never cut twice. */
  OUTBOX_KEY: 'floorguard_ops_outbox',
  outbox: function () {
    try { return JSON.parse(lsGet(this.OUTBOX_KEY) || '[]'); } catch (e) { return []; }
  },
  queue: function (item) {
    var q = this.outbox();
    item.id = item.id || rid('Q');
    item.queuedAt = isoNow();
    item.attempts = 0;
    q.push(item);
    lsSet(this.OUTBOX_KEY, JSON.stringify(q));
    return item;
  },
  dequeue: function (id) {
    lsSet(this.OUTBOX_KEY, JSON.stringify(this.outbox().filter(function (i) { return i.id !== id; })));
  },
  pendingCount: function () { return this.outbox().length; }
};
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('online', function () {
    if (Repository.mode === 'shared') Sync.set('SYNCING');
    Repository.refresh({ quiet: true }).catch(function () {});
  });
  window.addEventListener('offline', function () { Sync.set('OFFLINE'); });
}

/* ---------------- HTTP client (shared provider) ---------------- */
function pgFetch(path, opts) {
  opts = opts || {};
  var cfg = Repository.config;
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey)
    return Promise.reject(RepoError('NOT_CONFIGURED', 'Shared backend is not configured. Enter the Supabase URL and anon key in Settings.'));
  if (typeof fetch === 'undefined')
    return Promise.reject(RepoError('NETWORK', 'fetch is not available in this browser.'));
  /* Fail fast when the device knows it is offline: balance-changing work
     must never pretend to succeed, and there is no point waiting on a
     socket that cannot connect. */
  if (!isOnline()) {
    Sync.set('OFFLINE');
    return Promise.reject(RepoError('OFFLINE', 'OFFLINE — not synced.'));
  }
  var sess = readSession();
  var headers = {
    'apikey': cfg.supabaseAnonKey,
    'Authorization': 'Bearer ' + (sess && sess.access_token ? sess.access_token : cfg.supabaseAnonKey),
    'Accept': 'application/json'
  };
  var body = opts.body;
  var isBinary = (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) ||
    (typeof Uint8Array !== 'undefined' && body instanceof Uint8Array) ||
    (typeof Blob !== 'undefined' && body instanceof Blob);
  if (body !== undefined && !isBinary &&
      !(typeof FormData !== 'undefined' && body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  } else if (opts.contentType) {
    headers['Content-Type'] = opts.contentType;
  }
  if (opts.prefer) headers['Prefer'] = opts.prefer;
  var ctrl = null, timer = null;
  if (typeof AbortController !== 'undefined') {
    ctrl = new AbortController();
    timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, opts.timeoutMs || 20000);
  }
  return fetch(cfg.supabaseUrl + path, {
    method: opts.method || 'GET', headers: headers, body: body,
    signal: ctrl ? ctrl.signal : undefined
  }).then(function (res) {
    if (timer) clearTimeout(timer);
    /* raw:true — binary storage downloads return the Response untouched. */
    if (opts.raw) {
      if (!res.ok) throw RepoError(isOnline() ? 'NETWORK' : 'OFFLINE',
        isOnline() ? ('Shared backend error ' + res.status) : 'OFFLINE — not synced.');
      return res;
    }
    var ct = res.headers.get('content-type') || '';
    var parse = (ct.indexOf('application/json') >= 0) ? res.json() : res.text();
    return parse.then(function (data) {
      if (!res.ok) {
        var msg = (data && (data.message || data.error || data.hint)) || ('Request failed (' + res.status + ')');
        throw RepoError(data && data.code === 'PGRST301' ? 'NOT_AUTHENTICATED' : 'HTTP_' + res.status, String(msg), { status: res.status, body: data });
      }
      return data;
    });
  }).catch(function (err) {
    if (timer) clearTimeout(timer);
    if (err && err.name === 'RepoError') {
      /* Even a classified error (e.g. OFFLINE from a raw download) should
         move the sync dot. */
      if (err.code === 'OFFLINE') Sync.set('OFFLINE');
      throw err;
    }
    /* Network failure: distinguish offline from a broken backend. */
    var offline = !isOnline();
    Sync.set(offline ? 'OFFLINE' : 'SYNC_ERROR');
    throw RepoError(offline ? 'OFFLINE' : 'NETWORK',
      offline ? 'OFFLINE — not synced.' : 'Could not reach the shared backend.',
      { cause: String((err && err.message) || err) });
  });
}

/* ============================================================================
   Row <-> app-shape mappers.
   Backend rows are snake_case + normalized; the app's in-memory shapes are
   the camelCase records the screens already render. These mappers are the
   ONLY place that knows both shapes.
   ========================================================================== */
var Mappers = {
  /* ---- rolls ---- */
  rowToRoll: function (r) {
    return {
      id: r.id, barcode: r.barcode, manufacturer: r.manufacturer || '',
      style: r.style || '', color: r.color || '', materialType: r.material_type || '',
      widthIn: r.width_in, beginningIn: r.beginning_in,
      expectedLocation: r.location_code || '',
      measuredIn: (r.measured_in == null ? null : r.measured_in),
      measuredAt: r.measured_at || null, measuredBy: r.measured_by || null,
      lastCutAt: r.last_cut_at || null,
      /* Run 4 shared-mode fields: authoritative balance + optimistic version */
      sharedExpectedIn: r.expected_in,
      sharedVersion: r.version,
      warehouseId: r.warehouse_id
    };
  },
  rollToRow: function (roll, warehouseId) {
    return {
      id: roll.id, barcode: roll.barcode || roll.id, warehouse_id: warehouseId,
      manufacturer: roll.manufacturer || null, style: roll.style || null,
      color: roll.color || null, material_type: roll.materialType || null,
      width_in: roll.widthIn || null, beginning_in: roll.beginningIn || 0,
      expected_in: (roll.sharedExpectedIn != null ? roll.sharedExpectedIn
        : (roll.beginningIn || 0)),
      measured_in: (roll.measuredIn == null ? null : roll.measuredIn),
      measured_at: roll.measuredAt || null, measured_by: roll.measuredBy || null,
      location_code: roll.expectedLocation || null
    };
  },
  /* ---- work orders (+ material lines) ---- */
  rowToWorkOrder: function (w, lines) {
    var ls = (lines || []).filter(function (l) { return l.work_order_id === w.id; })
      .map(function (l) {
        return {
          id: l.id, materialType: l.material_type || '', style: l.style || '',
          color: l.color || '', uom: 'LF', widthIn: l.width_in, requiredIn: l.required_in
        };
      });
    return {
      id: w.id, number: w.number, property: w.property || '', account: w.account || '',
      opStatus: w.status || 'OPEN',
      assignmentStatus: w.assignment_status || 'UNASSIGNED',
      assigneeId: w.assignee_id || null,
      scheduledDate: w.scheduled_date || null, notes: w.notes || '',
      createdAt: w.created_at, lines: ls
    };
  },
  workOrderToRow: function (wo, warehouseId) {
    return {
      id: wo.id, number: wo.number, warehouse_id: warehouseId,
      property: wo.property || null, account: wo.account || null,
      status: wo.opStatus || 'OPEN',
      assignment_status: wo.assignmentStatus || 'UNASSIGNED',
      assignee_id: wo.assigneeId || null,
      scheduled_date: wo.scheduledDate || null, notes: wo.notes || null
    };
  },
  lineToRow: function (line, workOrderId) {
    return {
      id: line.id, work_order_id: workOrderId,
      material_type: line.materialType || null, style: line.style || null,
      color: line.color || null, width_in: line.widthIn || null,
      required_in: line.requiredIn || 0
    };
  },
  /* ---- inventory assignments ---- */
  rowToAssignment: function (r) {
    return {
      id: r.id, workOrderId: r.work_order_id, lineId: r.line_id, rollId: r.roll_id,
      requiredIn: r.required_in, reservedIn: r.reserved_in,
      actualCutIn: r.actual_cut_in, status: r.status,
      employee: r.employee_name, warehouseId: r.warehouse_id,
      location: r.location_code || '', at: r.created_at,
      mismatchApprovedBy: r.mismatch_approved_by || null,
      overApprovedBy: r.over_approved_by || null,
      rollVerifiedAt: r.roll_verified_at || null, rollVerifiedBy: r.roll_verified_by || null,
      locationVerifiedAt: r.location_verified_at || null,
      locationVerifiedBy: r.location_verified_by || null,
      releasedAt: r.released_at || null, releasedBy: r.released_by || null,
      consumedAt: r.consumed_at || null, consumedBy: r.consumed_by || null,
      cutId: r.cut_id || null
    };
  },
  /* ---- cuts ---- */
  rowToCut: function (r, woNumberById, barcodeByRollId) {
    return {
      id: r.id, rollId: r.roll_id, barcode: barcodeByRollId[r.roll_id] || r.roll_id,
      order: woNumberById[r.work_order_id] || '',
      prevIn: r.prev_in, inches: r.cut_in, newIn: r.new_in,
      location: r.location_code || '', by: r.employee_name || '',
      at: r.created_at, assignmentId: r.assignment_id || null
    };
  },
  cutToRow: function (c, woIdByNumber, warehouseId) {
    return {
      id: c.id, roll_id: c.rollId,
      work_order_id: (c.order && woIdByNumber[c.order]) || null,
      prev_in: c.prevIn, cut_in: c.inches, new_in: c.newIn,
      employee_name: c.by || null, warehouse_id: warehouseId,
      location_code: c.location || null,
      client_request_id: 'import-' + c.id,
      created_at: c.at || isoNow()
    };
  },
  /* ---- cycle counts ---- */
  rowToCount: function (r, rollById) {
    var roll = rollById[r.roll_id] || {};
    return {
      id: r.id, rollId: r.roll_id, barcode: roll.barcode || r.roll_id,
      style: roll.style || '', color: roll.color || '', widthIn: roll.widthIn,
      expectedLocation: roll.expectedLocation || '', scannedLocation: r.location_code || '',
      expectedIn: r.expected_in, physicalIn: r.measured_in, diffIn: r.diff_in,
      measured: !!r.measured, employee: r.employee_name || '',
      at: r.counted_at, status: r.status, flagged: false,
      sessionId: r.session_id || null, note: r.note || ''
    };
  },
  countToRow: function (c, warehouseId) {
    return {
      id: c.id, session_id: c.sessionId || null, roll_id: c.rollId,
      warehouse_id: warehouseId, location_code: c.scannedLocation || null,
      expected_in: c.expectedIn || 0, measured_in: c.physicalIn || 0,
      diff_in: c.diffIn || 0, status: c.status || 'COLLECTED',
      measured: c.measured !== false, employee_name: c.employee || null,
      counted_at: c.at || isoNow(), note: c.note || null
    };
  },
  /* ---- history events (shared ledger -> local assignmentEvents shape) ---- */
  rowToAssignEvent: function (r) {
    return {
      id: r.id, at: r.at, action: r.event_type, user: r.employee_name || '',
      warehouse: r.warehouse_id, workOrderId: r.work_order_id || null,
      lineId: null, rollId: r.roll_id || null, assignmentId: null,
      detail: r.detail || ''
    };
  },
  /* ---- documents (history cards) ---- */
  rowToDocument: function (r) {
    return {
      id: r.id, rollId: r.roll_id, kind: 'HISTORY_CARD',
      docType: r.document_type || 'HISTORY CARD',
      employee: r.employee_name || '', at: r.captured_at,
      location: r.location_code || null, sessionId: r.session_id || null,
      storagePath: r.storage_path, image: null, thumb: null,
      imports: [], source: 'SHARED BACKEND'
    };
  },

  /* ---- discrepancies ---- */
  rowToDiscrepancy: function (r) {
    return {
      id: r.id, rollId: r.roll_id, kind: r.kind || '', detail: r.detail || '',
      status: r.status, raisedBy: r.raised_by || '', resolvedBy: r.resolved_by || null,
      resolvedAt: r.resolved_at || null, at: r.created_at
    };
  }
};

/* ============================================================================
   LocalFloorGuardRepository — the existing localStorage architecture behind
   the async service interface. Zero behavior change: every method delegates
   to the battle-tested synchronous functions in app.js.
   ========================================================================== */
var LocalRepo = {
  name: 'local',
  getWorkOrders: function () { return Promise.resolve(FG().workOrders || []); },
  getWorkOrder: function (id) { return Promise.resolve(woById(id)); },
  assignInventory: function (o) { return Promise.resolve(assignInventory(o)); },
  releaseInventory: function (assignId, by) { return Promise.resolve(releaseAssignment(assignId, by)); },
  getRoll: function (id) { return Promise.resolve(rollById(id)); },
  getRollHistory: function (id) { return Promise.resolve(buildLocalRollHistory(id)); },
  recordCut: function (o) { return Promise.resolve(CutService.recordCut(o)); },
  startCountSession: function (o) {
    o = o || {};
    var rec = {
      id: rid('S'), mode: o.mode || 'STANDARD', status: 'ACTIVE',
      employee: o.employee || (typeof DB !== 'undefined' && DB.data.currentEmployee) || '',
      startedAt: isoNow(), note: o.note || ''
    };
    var fg = FG();
    fg.countSessions = fg.countSessions || [];
    fg.countSessions.push(rec);
    DB.save();
    return Promise.resolve({ ok: true, session: rec });
  },
  recordCycleCount: function (o) {
    /* Mirrors submitCount()'s record-building (same statuses, same MB
       stamping) without depending on the screen's transient S state. */
    var roll = rollById(o.rollId);
    if (!roll) return Promise.resolve({ ok: false, err: 'ROLL NOT FOUND' });
    var sys = systemBalance(roll.id);
    var physicalIn = Math.round(Number(o.physicalIn));
    var diff = physicalIn - sys;
    var status = computeStatus(roll, o.scannedLocation, physicalIn, !!o.flagged);
    var now = new Date();
    var rec = {
      id: rid('C'), rollId: roll.id, barcode: roll.barcode,
      style: roll.style, color: roll.color, widthIn: roll.widthIn,
      expectedLocation: roll.expectedLocation, scannedLocation: o.scannedLocation,
      expectedIn: sys, physicalIn: physicalIn, diffIn: diff,
      measured: true, employee: o.employee || DB.data.currentEmployee,
      at: now.toISOString(), date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
      status: status, flagged: !!o.flagged, sessionId: o.sessionId || null,
      note: o.note || ''
    };
    FG().counts.push(rec);
    roll.measuredIn = physicalIn;
    roll.measuredAt = rec.at;
    roll.measuredBy = rec.employee;
    DB.save();
    return Promise.resolve({ ok: true, rec: rec });
  },
  finishCountSession: function (id, o) {
    var s = (FG().countSessions || []).filter(function (x) { return x.id === id; })[0];
    if (!s) return Promise.resolve({ ok: false, err: 'SESSION NOT FOUND' });
    s.status = (o && o.cancelled) ? 'CANCELLED' : 'FINISHED';
    s.finishedAt = isoNow();
    DB.save();
    return Promise.resolve({ ok: true, session: s });
  },
  uploadHistoryCard: function (o) {
    /* Mirrors the doc-review save shape (sans camera plumbing). */
    var now = new Date();
    var rec = {
      id: rid('D'), rollId: o.rollId, barcode: o.barcode || o.rollId, raw: o.barcode || o.rollId,
      discovered: !!o.discovered, kind: 'HISTORY_CARD', docType: 'HISTORY CARD',
      image: o.imageDataUrl || null, thumb: o.thumbDataUrl || o.imageDataUrl || null,
      employee: o.employee || DB.data.currentEmployee, at: now.toISOString(),
      date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
      location: o.location || null, source: 'SHARED BACKEND',
      num: docsForRoll(o.rollId).length + 1, imports: [],
      sessionId: o.sessionId || null
    };
    FG().documents.push(rec);
    DB.save();
    return Promise.resolve({ ok: true, doc: rec });
  },
  getDocumentsForRoll: function (rollId) { return Promise.resolve(docsForRoll(rollId)); },
  createDiscrepancy: function (o) {
    var rec = {
      id: rid('X'), rollId: o.rollId, kind: o.kind || 'COUNT',
      detail: o.detail || '', status: 'OPEN',
      raisedBy: o.raisedBy || DB.data.currentEmployee, at: isoNow()
    };
    var fg = FG();
    fg.discrepancies = fg.discrepancies || [];
    fg.discrepancies.push(rec);
    DB.save();
    return Promise.resolve({ ok: true, rec: rec });
  },
  reviewDiscrepancy: function (id, o) {
    var d = (FG().discrepancies || []).filter(function (x) { return x.id === id; })[0];
    if (!d) return Promise.resolve({ ok: false, err: 'DISCREPANCY NOT FOUND' });
    d.status = 'RESOLVED';
    d.resolvedBy = (o && o.by) || DB.data.currentEmployee;
    d.resolvedAt = isoNow();
    d.resolution = (o && o.resolution) || '';
    DB.save();
    return Promise.resolve({ ok: true, rec: d });
  }
};

/* Local roll-history feed (data form of what ledgerHtml renders). */
function buildLocalRollHistory(rollId) {
  var ev = [];
  (FG().cuts || []).forEach(function (c) {
    if (c.rollId === rollId) ev.push({ kind: 'cut', at: c.at, by: c.by, inches: c.inches, order: c.order, newIn: c.newIn });
  });
  (FG().inventoryAssignments || []).forEach(function (a) {
    if (a.rollId === rollId) ev.push({ kind: 'assign', at: a.at, status: a.status, reservedIn: a.reservedIn, workOrderId: a.workOrderId, employee: a.employee });
  });
  (FG().counts || []).forEach(function (c) {
    if (c.rollId === rollId) ev.push({ kind: 'count', at: c.at, status: c.status, diffIn: c.diffIn, employee: c.employee });
  });
  (FG().documents || []).forEach(function (d) {
    if (d.rollId === rollId) ev.push({ kind: 'doc', at: d.at, employee: d.employee });
  });
  ev.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  return ev;
}

/* ============================================================================
   SharedFloorGuardRepository — Supabase-compatible backend.
   Talks PostgREST (/rest/v1), Storage (/storage/v1) and Auth (/auth/v1) over
   fetch. Balance changes go through the atomic RPCs (record_cut,
   reserve_inventory, record_cycle_count) — never direct table writes.
   ========================================================================== */
var SharedRepo = {
  name: 'shared',
  wh: function () { return (Repository.config.warehouseId || 'main'); },

  /* ---- raw primitives ---- */
  _q: function (params) {
    return Object.keys(params || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
  },
  _get: function (table, params) {
    var q = this._q(params);
    return pgFetch('/rest/v1/' + table + (q ? '?' + q : ''), {});
  },
  _post: function (table, rows) {
    return pgFetch('/rest/v1/' + table, { method: 'POST', body: rows, prefer: 'return=representation' });
  },
  _patch: function (table, filter, patch) {
    return pgFetch('/rest/v1/' + table + '?' + filter, { method: 'PATCH', body: patch, prefer: 'return=representation' });
  },
  _rpc: function (name, args) {
    return pgFetch('/rest/v1/rpc/' + name, { method: 'POST', body: args || {} });
  },
  _rpcResult: function (res) {
    if (!res || res.ok !== true) {
      var e = (res && res.error) || { code: 'NETWORK', message: 'Request failed.' };
      throw RepoError(e.code || 'NETWORK', e.message || 'Request failed.', e);
    }
    return res;
  },

  /* ---- auth (pilot) ---- */
  signIn: function (email, password) {
    var cfg = Repository.config;
    return pgFetch('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email: email, password: password }
    }).then(function (s) {
      if (!s || !s.access_token) throw RepoError('NOT_AUTHENTICATED', 'Sign-in failed.');
      writeSession({ access_token: s.access_token, refresh_token: s.refresh_token || null, user: s.user || null, email: email });
      return { ok: true, email: email };
    });
  },
  signOut: function () {
    var sess = readSession();
    writeSession(null);
    if (sess && sess.access_token) {
      pgFetch('/auth/v1/logout', { method: 'POST', body: {} }).catch(function () {});
    }
    return Promise.resolve({ ok: true });
  },

  /* ---- work orders ---- */
  getWorkOrders: function () {
    var self = this;
    return Promise.all([
      self._get('work_orders', { warehouse_id: 'eq.' + self.wh(), select: '*', order: 'number.asc' }),
      self._get('work_order_material_lines', { select: '*' })
    ]).then(function (parts) {
      return parts[0].map(function (w) { return Mappers.rowToWorkOrder(w, parts[1]); });
    });
  },
  getWorkOrder: function (id) {
    var self = this;
    return Promise.all([
      self._get('work_orders', { id: 'eq.' + id, select: '*' }),
      self._get('work_order_material_lines', { select: '*' })
    ]).then(function (parts) {
      if (!parts[0].length) return null;
      return Mappers.rowToWorkOrder(parts[0][0], parts[1]);
    });
  },

  /* ---- rolls ---- */
  getRoll: function (id) {
    return this._get('rolls', { id: 'eq.' + id, select: '*' }).then(function (rows) {
      return rows.length ? Mappers.rowToRoll(rows[0]) : null;
    });
  },
  ensureRoll: function (roll) {
    /* Discovered rolls must exist canonically before they can be reserved. */
    var row = Mappers.rollToRow(roll, this.wh());
    return this._post('rolls', row).catch(function (err) {
      if (err && (err.code === 'HTTP_409' || err.code === 'HTTP_400')) return [row]; /* already there */
      throw err;
    });
  },
  getRollHistory: function (rollId) {
    var self = this;
    return Promise.all([
      self._get('cut_transactions', { roll_id: 'eq.' + rollId, select: '*', order: 'created_at.asc' }),
      self._get('history_events', { roll_id: 'eq.' + rollId, select: '*', order: 'at.asc' }),
      self._get('cycle_count_records', { roll_id: 'eq.' + rollId, select: '*', order: 'counted_at.asc' }),
      self._get('inventory_assignments', { roll_id: 'eq.' + rollId, select: '*' }),
      self._get('documents', { roll_id: 'eq.' + rollId, select: '*' })
    ]).then(function (p) {
      var ev = [];
      p[0].forEach(function (c) { ev.push({ kind: 'cut', at: c.created_at, by: c.employee_name, inches: c.cut_in, order: '', newIn: c.new_in }); });
      p[1].forEach(function (h) { ev.push({ kind: 'event', at: h.at, type: h.event_type, by: h.employee_name, detail: h.detail }); });
      p[2].forEach(function (c) { ev.push({ kind: 'count', at: c.counted_at, status: c.status, diffIn: c.diff_in, employee: c.employee_name }); });
      p[3].forEach(function (a) { ev.push({ kind: 'assign', at: a.created_at, status: a.status, reservedIn: a.reserved_in, workOrderId: a.work_order_id, employee: a.employee_name }); });
      p[4].forEach(function (d) { ev.push({ kind: 'doc', at: d.captured_at, employee: d.employee_name }); });
      ev.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
      return ev;
    });
  },

  /* ---- inventory assignments ---- */
  assignInventory: function (o) {
    /* o: {workOrderId, lineId, rollId, reservedIn, employee, warehouseId,
           location, mismatchApprovedBy, overApprovedBy, expectedVersion,
           clientRequestId} */
    var self = this;
    return self._rpc('reserve_inventory', {
      p_work_order_id: o.workOrderId, p_line_id: o.lineId || null,
      p_roll_id: o.rollId, p_reserved_in: Math.round(o.reservedIn),
      p_employee_name: o.employee || null,
      p_warehouse_id: o.warehouseId || self.wh(),
      p_location_code: o.location || null,
      p_client_request_id: o.clientRequestId || rid('AR'),
      p_expected_version: (o.expectedVersion == null ? null : o.expectedVersion),
      p_mismatch_approved_by: o.mismatchApprovedBy || null,
      p_over_approved_by: o.overApprovedBy || null
    }).then(function (res) {
      var r = self._rpcResult(res);
      return { ok: true, duplicate: !!r.duplicate, assignmentId: r.assignment_id, rollVersion: r.roll_version };
    });
  },
  releaseInventory: function (assignId, by) {
    var self = this;
    return self._patch('inventory_assignments', 'id=eq.' + encodeURIComponent(assignId), {
      status: 'RELEASED', released_at: isoNow(), released_by: by || null
    }).then(function (rows) {
      if (!rows.length) throw RepoError('NOT_FOUND', 'Assignment not found.');
      return self._post('audit_events', [{
        id: rid('A'), user_name: by || null, warehouse_id: self.wh(),
        action: 'INVENTORY_RELEASED', entity_type: 'inventory_assignment',
        entity_id: assignId, related_roll_id: rows[0].roll_id,
        related_work_order_id: rows[0].work_order_id
      }]).then(function () { return { ok: true, rec: Mappers.rowToAssignment(rows[0]) }; });
    });
  },

  /* ---- cuts (atomic, version-checked, idempotent) ---- */
  recordCut: function (o) {
    var self = this;
    var clientRequestId = o.clientRequestId || rid('CR');
    return self._rpc('record_cut', {
      p_roll_id: o.rollId, p_order_number: o.order || '',
      p_cut_in: Math.round(o.cutIn),
      p_employee_name: o.employee || null, p_location_code: o.location || null,
      p_warehouse_id: o.warehouseId || self.wh(),
      p_assignment_id: o.assignmentId || null,
      p_client_request_id: clientRequestId,
      p_expected_version: (o.expectedVersion == null ? null : o.expectedVersion)
    }).then(function (res) {
      var r = self._rpcResult(res);
      return {
        ok: true, duplicate: !!r.duplicate, cutId: r.cut_id,
        newBalanceIn: r.new_balance_in, newVersion: r.new_version,
        clientRequestId: clientRequestId
      };
    });
  },

  /* ---- cycle counts ---- */
  startCountSession: function (o) {
    o = o || {};
    return this._post('cycle_count_sessions', [{
      id: rid('S'), warehouse_id: this.wh(), mode: o.mode || 'STANDARD',
      status: 'ACTIVE', employee_name: o.employee || null, note: o.note || null
    }]).then(function (rows) { return { ok: true, session: rows[0] }; });
  },
  recordCycleCount: function (o) {
    /* o: {rollId, scannedLocation, expectedIn, physicalIn, status, employee,
           sessionId, note} — atomic: record + MB stamp + history + audit. */
    var self = this;
    return self._rpc('record_cycle_count', {
      p_roll_id: o.rollId, p_warehouse_id: o.warehouseId || self.wh(),
      p_location_code: o.scannedLocation || null,
      p_expected_in: Math.round(o.expectedIn), p_measured_in: Math.round(o.physicalIn),
      p_status: o.status, p_employee_name: o.employee || null,
      p_session_id: o.sessionId || null, p_note: o.note || null
    }).then(function (res) {
      var r = self._rpcResult(res);
      return { ok: true, recordId: r.record_id, diffIn: r.diff_in, rollVersion: r.roll_version };
    });
  },
  finishCountSession: function (id, o) {
    return this._patch('cycle_count_sessions', 'id=eq.' + encodeURIComponent(id), {
      status: (o && o.cancelled) ? 'CANCELLED' : 'FINISHED', finished_at: isoNow()
    }).then(function (rows) {
      if (!rows.length) throw RepoError('NOT_FOUND', 'Session not found.');
      return { ok: true, session: rows[0] };
    });
  },

  /* ---- history cards (private storage + metadata) ---- */
  uploadHistoryCard: function (o) {
    /* o: {rollId, imageDataUrl|imageBytes, mimeType, employee, location,
           sessionId, originalFilename} */
    var self = this;
    var wh = self.wh();
    var bytes = dataUrlToBytes(o.imageDataUrl || o.imageBytes);
    if (!bytes) return Promise.reject(RepoError('INVALID_INPUT', 'No image data.'));
    var path = wh + '/' + o.rollId + '/' + rid('HC') + '.jpg';
    return pgFetch('/storage/v1/object/history-cards/' + path, {
      method: 'POST', body: bytes, contentType: o.mimeType || 'image/jpeg'
    }).then(function () {
      var row = {
        id: rid('D'), roll_id: o.rollId, warehouse_id: wh,
        storage_path: path, document_type: 'HISTORY_CARD',
        employee_name: o.employee || null, location_code: o.location || null,
        session_id: o.sessionId || null, captured_at: isoNow(),
        original_filename: o.originalFilename || null,
        mime_type: o.mimeType || 'image/jpeg', byte_size: bytes.length
      };
      return self._post('documents', [row]).then(function () {
        return self._post('history_events', [{
          id: rid('H'), roll_id: o.rollId, warehouse_id: wh,
          event_type: 'HISTORY_CARD_CAPTURED', employee_name: o.employee || null,
          detail: 'History card captured', at: isoNow()
        }]).catch(function () {});
      }).then(function () {
        var doc = Mappers.rowToDocument(row);
        doc.image = o.imageDataUrl || null;
        return { ok: true, doc: doc };
      });
    });
  },
  getDocumentsForRoll: function (rollId) {
    var self = this;
    /* Metadata only — the image bytes stay in private storage until the doc
       screen requests them (session-only; never written to localStorage). */
    return self._get('documents', { roll_id: 'eq.' + rollId, select: '*' })
      .then(function (rows) {
        return rows.map(function (r) { return Mappers.rowToDocument(r); });
      });
  },
  /* Fetch one history-card image as a data URL (session-only). */
  downloadHistoryCard: function (storagePath) {
    if (typeof FileReader === 'undefined')
      return Promise.reject(RepoError('NETWORK', 'Image download needs a browser.'));
    return pgFetch('/storage/v1/object/history-cards/' + storagePath, { raw: true })
      .then(function (res) { return res.blob(); })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { reject(RepoError('NETWORK', 'Could not read the history card image.')); };
          fr.readAsDataURL(blob);
        });
      });
  },
  /* Confirmed extraction: becomes a history event only — never touches
     trusted balances. */
  confirmHistoryImport: function (o) {
    var self = this;
    var wh = o.warehouseId || self.wh();
    return self._post('history_card_imports', {
      id: rid('X'), document_id: o.docId, roll_id: o.rollId, warehouse_id: wh,
      extracted: o.fields, status: 'CONFIRMED',
      reviewed_by: o.employee, reviewed_at: isoNow()
    }, { prefer: 'return=representation' }).then(function (rows) {
      var imp = rows[0];
      return self._post('history_events', {
        id: rid('H'), roll_id: o.rollId, warehouse_id: wh,
        event_type: 'HISTORY_IMPORTED', employee_name: o.employee,
        detail: 'History imported from card ' + o.docId, at: isoNow()
      }).then(function () { return { ok: true, importId: imp.id }; });
    });
  },

  /* ---- discrepancies ---- */
  createDiscrepancy: function (o) {
    var self = this;
    return self._post('discrepancies', [{
      id: rid('X'), roll_id: o.rollId, warehouse_id: self.wh(),
      kind: o.kind || 'COUNT', detail: o.detail || '',
      status: 'OPEN', raised_by: o.raisedBy || null
    }]).then(function (rows) { return { ok: true, rec: Mappers.rowToDiscrepancy(rows[0]) }; });
  },
  reviewDiscrepancy: function (id, o) {
    var self = this;
    return self._patch('discrepancies', 'id=eq.' + encodeURIComponent(id), {
      status: 'RESOLVED', resolved_by: (o && o.by) || null, resolved_at: isoNow()
    }).then(function (rows) {
      if (!rows.length) throw RepoError('NOT_FOUND', 'Discrepancy not found.');
      return { ok: true, rec: Mappers.rowToDiscrepancy(rows[0]) };
    });
  },

  /* ---- full hydrate: shared backend -> in-memory store ----
     Wholesale REPLACE (not merge): the backend is the source of truth. */
  hydrate: function () {
    var self = this, wh = self.wh();
    Sync.set('SYNCING');
    var get = function (t, extra) {
      var p = { warehouse_id: 'eq.' + wh, select: '*' };
      Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
      return self._get(t, p);
    };
    return Promise.all([
      get('warehouses', {}).catch(function () { return []; }),
      self._get('users', { warehouse_id: 'eq.' + wh, select: '*' }).catch(function () { return []; }),
      get('rolls'), get('work_orders'), self._get('work_order_material_lines', { select: '*' }),
      get('inventory_assignments'), get('cut_transactions'),
      get('cycle_count_sessions'), get('cycle_count_records'),
      get('history_events'), get('documents'), get('history_card_imports'),
      get('discrepancies'), get('audit_events')
    ]).then(function (p) {
      var warehouses = p[0], users = p[1], rollRows = p[2], woRows = p[3],
          lineRows = p[4], asnRows = p[5], cutRows = p[6], sessRows = p[7],
          countRows = p[8], histRows = p[9], docRows = p[10], impRows = p[11],
          discRows = p[12], auditRows = p[13];
      var fg = FG();
      /* warehouses + employees */
      var roleMap = { WAREHOUSE_EMPLOYEE: 'WORKER', SUPERVISOR: 'SUPERVISOR', MANAGER: 'MANAGER', ADMIN: 'ADMIN' };
      if (warehouses.length) {
        DB.data.warehouses = warehouses.map(function (w) { return { id: w.id, name: w.name }; });
        if (!DB.data.currentWarehouse) DB.data.currentWarehouse = wh;
      }
      if (users.length) {
        DB.data.employees = users.filter(function (u) { return u.active; }).map(function (u) { return u.display_name; });
        DB.data.employeeRoles = {};
        users.forEach(function (u) { DB.data.employeeRoles[u.display_name] = roleMap[u.role] || 'WORKER'; });
        if (DB.data.currentEmployee && DB.data.employees.indexOf(DB.data.currentEmployee) < 0) {
          DB.data.currentEmployee = null; /* signed-in employee not in this warehouse */
        }
      }
      /* rolls */
      var barcodeByRollId = {}, rollByIdMap = {};
      fg.rolls = rollRows.map(function (r) {
        var roll = Mappers.rowToRoll(r);
        barcodeByRollId[roll.id] = roll.barcode;
        rollByIdMap[roll.id] = roll;
        return roll;
      });
      /* work orders */
      var woNumberById = {}, woIdByNumber = {};
      fg.workOrders = woRows.map(function (w) {
        woNumberById[w.id] = w.number; woIdByNumber[w.number] = w.id;
        return Mappers.rowToWorkOrder(w, lineRows);
      });
      /* assignments, cuts, counts, sessions */
      fg.inventoryAssignments = asnRows.map(Mappers.rowToAssignment);
      fg.cuts = cutRows.map(function (c) { return Mappers.rowToCut(c, woNumberById, barcodeByRollId); });
      fg.countSessions = sessRows;
      fg.counts = countRows.map(function (c) { return Mappers.rowToCount(c, rollByIdMap); });
      /* history -> local assignmentEvents feed (WO Inventory activity) */
      fg.assignmentEvents = histRows.map(Mappers.rowToAssignEvent);
      /* documents + imports */
      var impByDoc = {};
      impRows.forEach(function (im) { (impByDoc[im.document_id] = impByDoc[im.document_id] || []).push(im); });
      fg.documents = docRows.map(function (d) {
        var doc = Mappers.rowToDocument(d);
        doc.imports = (impByDoc[d.id] || []).map(function (im) {
          return {
            id: im.id, docId: im.document_id, fields: im.extracted,
            status: im.status, confirmedBy: im.reviewed_by, confirmedAt: im.reviewed_at
          };
        });
        return doc;
      });
      fg.discrepancies = discRows.map(Mappers.rowToDiscrepancy);
      fg.auditEvents = auditRows;
      DB.save();
      Sync.set(isOnline() ? 'SYNCED' : 'OFFLINE');
      return {
        ok: true, rolls: fg.rolls.length, workOrders: fg.workOrders.length,
        assignments: fg.inventoryAssignments.length, cuts: fg.cuts.length,
        counts: fg.counts.length, documents: fg.documents.length,
        historyEvents: fg.assignmentEvents.length
      };
    }).catch(function (err) {
      Sync.set(err && err.code === 'OFFLINE' ? 'OFFLINE' : 'SYNC_ERROR');
      throw err;
    });
  },

  /* ---- local -> shared import (explicit, idempotent) ---- */
  importAll: function (snap) {
    var self = this, wh = self.wh(), summary = { skipped: 0 };
    function upsert(table, rows, label) {
      var done = 0;
      var chain = Promise.resolve();
      (rows || []).forEach(function (row) {
        chain = chain.then(function () {
          /* Existing shared records are NEVER overwritten: check first,
             insert only when the id is absent. Re-imports are pure skips. */
          return self._get(table, { id: 'eq.' + row.id, select: 'id', limit: 1 }).then(function (found) {
            if (found && found.length) { summary.skipped++; return; }
            return self._post(table, [row]).then(function () { done++; });
          });
        });
      });
      return chain.then(function () { summary[label || table] = done; });
    }
    var woIdByNumber = {};
    (snap.workOrders || []).forEach(function (w) { woIdByNumber[w.number] = w.id; });
    var barcodeByRollId = {};
    (snap.rolls || []).forEach(function (r) { barcodeByRollId[r.id] = r.barcode || r.id; });
    var rollByIdMap = {};
    (snap.rolls || []).forEach(function (r) { rollByIdMap[r.id] = r; });
    return upsert('rolls', (snap.rolls || []).map(function (r) { return Mappers.rollToRow(r, wh); }), 'rolls')
      .then(function () {
        return upsert('work_orders', (snap.workOrders || []).map(function (w) { return Mappers.workOrderToRow(w, wh); }), 'workOrders');
      })
      .then(function () {
        var lines = [];
        (snap.workOrders || []).forEach(function (w) {
          (w.lines || []).forEach(function (l) { lines.push(Mappers.lineToRow(l, w.id)); });
        });
        return upsert('work_order_material_lines', lines, 'materialLines');
      })
      .then(function () {
        /* assignments: map local shape -> row */
        var rows = (snap.assignments || []).map(function (a) {
          return {
            id: a.id, work_order_id: a.workOrderId, line_id: a.lineId || null,
            roll_id: a.rollId, warehouse_id: wh, required_in: a.requiredIn || 0,
            reserved_in: a.reservedIn || 0, actual_cut_in: a.actualCutIn || null,
            status: a.status, employee_name: a.employee || null,
            location_code: a.location || null,
            mismatch_approved_by: a.mismatchApprovedBy || null,
            over_approved_by: a.overApprovedBy || null,
            released_at: a.releasedAt || null, released_by: a.releasedBy || null,
            consumed_at: a.consumedAt || null, consumed_by: a.consumedBy || null,
            cut_id: a.cutId || null, created_at: a.at || isoNow()
          };
        });
        return upsert('inventory_assignments', rows, 'assignments');
      })
      .then(function () {
        /* cuts go through the atomic RPC so balances stay consistent */
        var chain = Promise.resolve(), done = 0;
        (snap.cuts || []).forEach(function (c) {
          chain = chain.then(function () {
            return self._rpc('record_cut', {
              p_roll_id: c.rollId, p_order_number: c.order || '',
              p_cut_in: Math.round(c.inches),
              p_employee_name: c.by || null, p_location_code: c.location || null,
              p_warehouse_id: wh, p_assignment_id: null,
              p_client_request_id: 'import-' + c.id, p_expected_version: null
            }).catch(function () {});
          }).then(function () { done++; });
        });
        return chain.then(function () { summary.cuts = done; });
      })
      .then(function () {
        return upsert('cycle_count_sessions',
          (snap.countSessions || []).map(function (s) {
            return {
              id: s.id, warehouse_id: wh, mode: s.mode || 'STANDARD',
              status: s.status || 'FINISHED', employee_name: s.employee || null,
              started_at: s.startedAt || isoNow(), finished_at: s.finishedAt || null,
              note: s.note || null
            };
          }), 'countSessions');
      })
      .then(function () {
        return upsert('cycle_count_records',
          (snap.counts || []).map(function (c) { return Mappers.countToRow(c, wh); }), 'counts');
      })
      .then(function () {
        return upsert('history_events',
          (snap.historyEvents || []).map(function (e, i) {
            return {
              id: e.id || ('HI' + i + '-' + Date.now().toString(36)),
              roll_id: e.rollId || (snap.rolls[0] && snap.rolls[0].id) || 'unknown',
              warehouse_id: wh, event_type: 'SUPERVISOR_REVIEW',
              employee_name: e.user || null, work_order_id: e.workOrderId || null,
              detail: '[' + (e.action || 'EVENT') + '] ' + (e.detail || ''), at: e.at || isoNow()
            };
          }), 'historyEvents');
      })
      .then(function () {
        /* documents metadata only — original bytes stay on the device until
           re-captured in shared mode (never silently uploaded). */
        return upsert('documents',
          (snap.documents || []).map(function (d) {
            return {
              id: d.id, roll_id: d.rollId, warehouse_id: wh,
              storage_path: wh + '/' + d.rollId + '/' + d.id + '.jpg',
              document_type: 'HISTORY_CARD', employee_name: d.employee || null,
              location_code: d.location || null, session_id: d.sessionId || null,
              captured_at: d.at || isoNow(), mime_type: 'image/jpeg', byte_size: null
            };
          }), 'documents');
      })
      .then(function () {
        return upsert('audit_events',
          (snap.auditEvents || []).map(function (a, i) {
            return {
              id: a.id || ('AI' + i + '-' + Date.now().toString(36)),
              user_name: a.user_name || a.user || null, warehouse_id: wh,
              action: a.action || 'EVENT', entity_type: a.entity_type || 'record',
              entity_id: a.entity_id || null,
              related_work_order_id: a.related_work_order_id || a.workOrderId || null,
              related_roll_id: a.related_roll_id || a.rollId || null,
              created_at: a.created_at || a.at || isoNow()
            };
          }), 'auditEvents');
      })
      .then(function () { return { ok: true, summary: summary }; });
  }
};

/* dataURL <-> bytes helpers (browser FileReader, node Buffer fallback) */
function dataUrlToBytes(dataUrl) {
  if (!dataUrl) return null;
  if (typeof Buffer !== 'undefined' && !(typeof window !== 'undefined' && window.FileReader)) {
    /* node/test: accept raw Buffer, base64 string, or data URL */
    if (Buffer.isBuffer(dataUrl)) return dataUrl;
    var m = /^data:[^;]+;base64,(.*)$/.exec(dataUrl);
    return Buffer.from(m ? m[1] : dataUrl, 'base64');
  }
  var mm = /^data:[^;]+;base64,(.*)$/.exec(dataUrl || '');
  if (!mm) return null;
  var bin = atob(mm[1]);
  var arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function bytesToDataUrl(data, mime) {
  mime = mime || 'image/jpeg';
  if (typeof Buffer !== 'undefined' && !(typeof window !== 'undefined' && window.FileReader)) {
    var b64 = Buffer.isBuffer(data) ? data.toString('base64')
      : Buffer.from(data).toString('base64');
    return 'data:' + mime + ';base64,' + b64;
  }
  return null; /* browser path resolves via FileReader at the call site */
}

/* ============================================================================
   Repository — the facade. UI code calls these; the active provider answers.
   ========================================================================== */
var SERVICE_METHODS = [
  'getWorkOrders', 'getWorkOrder', 'assignInventory', 'releaseInventory',
  'getRoll', 'getRollHistory', 'recordCut',
  'startCountSession', 'recordCycleCount', 'finishCountSession',
  'uploadHistoryCard', 'getDocumentsForRoll', 'downloadHistoryCard', 'confirmHistoryImport',
  'createDiscrepancy', 'reviewDiscrepancy'
];
var Repository = {
  mode: 'local',
  config: readProviderConfig(),
  configure: function () {
    this.config = readProviderConfig();
    var c = this.config;
    this.mode = (c.dataProvider === 'shared' && c.supabaseUrl && c.supabaseAnonKey) ? 'shared' : 'local';
    Sync.set(this.mode === 'shared' ? (isOnline() ? 'SYNCED' : 'OFFLINE') : 'SYNCED');
    return this.mode;
  },
  provider: function () { return this.mode === 'shared' ? SharedRepo : LocalRepo; },
  saveConfig: function (patch) {
    writeProviderConfig(patch || {});
    return this.configure();
  },
  /* ---- auth (shared pilot) ---- */
  signIn: function (email, password) { return SharedRepo.signIn(email, password); },
  signOut: function () { return SharedRepo.signOut(); },
  session: function () { return readSession(); },
  /* ---- sync ---- */
  refresh: function (opts) {
    opts = opts || {};
    if (this.mode !== 'shared') return Promise.resolve({ mode: 'local' });
    if (!opts.quiet) Sync.set('SYNCING');
    return SharedRepo.hydrate().then(function (s) { return s; })
      .catch(function (err) { if (!opts.quiet) throw err; return { ok: false, error: err && err.code }; });
  },
  /* ---- local -> shared migration ---- */
  exportLocal: function () {
    var fg = FG();
    return {
      exportedAt: isoNow(),
      warehouseId: (typeof DB !== 'undefined' && DB.data.currentWarehouse) || 'main',
      warehouses: (typeof DB !== 'undefined' ? DB.data.warehouses : []) || [],
      employees: (typeof DB !== 'undefined' ? { names: DB.data.employees, roles: DB.data.employeeRoles } : {}),
      rolls: fg.rolls || [], workOrders: fg.workOrders || [],
      assignments: fg.inventoryAssignments || [], cuts: fg.cuts || [],
      counts: fg.counts || [], countSessions: fg.countSessions || [],
      historyEvents: fg.assignmentEvents || [], documents: fg.documents || [],
      discrepancies: fg.discrepancies || [], auditEvents: fg.auditEvents || []
    };
  },
  importShared: function (snapshot) {
    var self = this;
    if (self.mode !== 'shared')
      return Promise.reject(RepoError('NOT_CONFIGURED', 'Switch to Shared Pilot before importing.'));
    Sync.set('SYNCING');
    return SharedRepo.importAll(snapshot).then(function (r) {
      Sync.set('SYNCED');
      return r;
    }).catch(function (err) {
      Sync.set(err && err.code === 'OFFLINE' ? 'OFFLINE' : 'SYNC_ERROR');
      throw err;
    });
  }
};
SERVICE_METHODS.forEach(function (m) {
  Repository[m] = function () {
    var p = Repository.provider();
    return p[m].apply(p, arguments);
  };
});

/* ============================================================================
   SharedFlow — shared-mode mutation flows used by the UI.
   Each flow: validate locally (same business rules as local mode) ->
   atomic backend RPC -> apply the authoritative result to the in-memory
   store so screens re-render instantly (no rewrite of screens needed).
   ========================================================================== */
var SharedFlow = {
  /* opts: {rollId, order, cutIn, employee, location, assignmentId, woId} */
  recordCut: function (opts) {
    var roll = rollById(opts.rollId);
    if (!roll) return Promise.reject(RepoError('ROLL_NOT_FOUND', 'Roll not found.'));
    var order = String(opts.order || '').trim().toUpperCase();
    if (!order) return Promise.reject(RepoError('INVALID_INPUT', 'Enter the order number.'));
    var cutIn = Math.round(Number(opts.cutIn));
    if (!isFinite(cutIn) || cutIn <= 0)
      return Promise.reject(RepoError('INVALID_CUT', 'Cut length must be more than zero.'));
    var prevIn = systemBalance(roll.id);
    if (cutIn > prevIn)
      return Promise.reject(RepoError('INSUFFICIENT_BALANCE',
        'Cut (' + fmtLen(cutIn) + ') exceeds the current balance (' + fmtLen(prevIn) + ').'));
    var clientRequestId = opts.clientRequestId || rid('CR');
    var self = this;
    return SharedRepo.recordCut({
      rollId: roll.id, order: order, cutIn: cutIn,
      employee: opts.employee || DB.data.currentEmployee,
      location: opts.location || roll.expectedLocation,
      warehouseId: Repository.config.warehouseId,
      assignmentId: opts.assignmentId || null,
      expectedVersion: (roll.sharedVersion == null ? null : roll.sharedVersion),
      clientRequestId: clientRequestId
    }).then(function (r) {
      return self._applyCut(roll, {
        order: order, cutIn: cutIn, prevIn: prevIn,
        employee: opts.employee || DB.data.currentEmployee,
        location: opts.location || roll.expectedLocation,
        assignmentId: opts.assignmentId || null, woId: opts.woId || null
      }, r);
    });
  },
  _applyCut: function (roll, opts, r) {
    var now = new Date();
    var rec = {
      id: r.cutId, rollId: roll.id, barcode: roll.barcode, order: opts.order,
      prevIn: opts.prevIn, inches: opts.cutIn, newIn: r.newBalanceIn,
      location: opts.location, by: opts.employee,
      at: now.toISOString(), date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
      assignmentId: opts.assignmentId
    };
    FG().cuts.push(rec);
    roll.sharedExpectedIn = r.newBalanceIn;
    roll.sharedVersion = r.newVersion;
    if (opts.assignmentId) {
      var a = (FG().inventoryAssignments || []).filter(function (x) { return x.id === opts.assignmentId; })[0];
      if (a && a.status === 'RESERVED') {
        a.status = 'CONSUMED';
        a.consumedAt = now.toISOString();
        a.consumedBy = opts.employee;
        a.cutId = rec.id;
        a.actualCutIn = opts.cutIn;
        logAssignEvent('ASSIGNMENT_CONSUMED', {
          user: opts.employee, workOrderId: a.workOrderId, lineId: a.lineId,
          rollId: a.rollId, assignmentId: a.id,
          detail: 'Cut ' + fmtLen(opts.cutIn) + ' (' + rec.id + ')'
        });
      }
    }
    if (opts.woId) {
      var wo = woById(opts.woId);
      if (wo) {
        wo.rollId = roll.id;
        if (wo.opStatus === 'OPEN') {
          wo.opStatus = 'IN_PROGRESS';
          /* best-effort: persist the status centrally, never fail the cut */
          SharedRepo._patch('work_orders', 'id=eq.' + encodeURIComponent(wo.id),
            { status: 'IN_PROGRESS' }).catch(function () {});
        }
      }
    }
    DB.save();
    return { ok: true, rec: rec, duplicate: !!r.duplicate };
  },

  /* o: same shape as assignInventory(o) */
  assignInventory: function (o) {
    var v = validateAssignInput(o);
    if (!v.ok) return Promise.resolve({ ok: false, err: v.err, compat: v.compat, over: v.over });
    var self = this;
    var ensure = v.discoveredRoll ? SharedRepo.ensureRoll(v.roll) : Promise.resolve();
    return ensure.then(function () {
      return SharedRepo.assignInventory({
        workOrderId: v.wo.id, lineId: v.line.id, rollId: v.roll.id,
        reservedIn: v.reservedIn, employee: v.employee,
        warehouseId: Repository.config.warehouseId,
        location: v.roll.expectedLocation || v.roll.lastLocation || '',
        mismatchApprovedBy: v.mismatchBy, overApprovedBy: v.overBy,
        expectedVersion: (v.roll.sharedVersion == null ? null : v.roll.sharedVersion),
        clientRequestId: o.clientRequestId || rid('AR')
      });
    }).then(function (r) {
      return self._applyAssign(v, r.assignmentId);
    });
  },
  _applyAssign: function (v, assignmentId) {
    var now = new Date().toISOString();
    var rec = {
      id: assignmentId, workOrderId: v.wo.id, lineId: v.line.id, rollId: v.roll.id,
      discovered: v.discoveredRoll,
      requiredIn: v.line.requiredIn, reservedIn: v.reservedIn,
      employee: v.employee, warehouseId: Repository.config.warehouseId,
      location: v.roll.expectedLocation || v.roll.lastLocation || '',
      at: now, status: 'RESERVED',
      mismatchApprovedBy: v.mismatchBy, overApprovedBy: v.overBy,
      rollVerifiedAt: null, rollVerifiedBy: null,
      locationVerifiedAt: null, locationVerifiedBy: null,
      releasedAt: null, releasedBy: null,
      consumedAt: null, consumedBy: null, cutId: null, actualCutIn: null
    };
    FG().inventoryAssignments.push(rec);
    logAssignEvent('INVENTORY_ASSIGNED', {
      user: v.employee, workOrderId: v.wo.id, lineId: v.line.id,
      rollId: v.roll.id, assignmentId: rec.id,
      detail: 'Roll ' + v.roll.id + ' → ' + v.wo.number + ' line ' + v.line.id +
        ', reserved ' + fmtLen(v.reservedIn)
    });
    if (v.mismatchBy) logAssignEvent('MATERIAL_MISMATCH_OVERRIDE', {
      user: v.mismatchBy, workOrderId: v.wo.id, lineId: v.line.id,
      rollId: v.roll.id, assignmentId: rec.id,
      detail: 'Approved ' + v.compat.verdict
    });
    if (v.overBy) logAssignEvent('OVER_RESERVATION_APPROVED', {
      user: v.overBy, workOrderId: v.wo.id, lineId: v.line.id,
      rollId: v.roll.id, assignmentId: rec.id,
      detail: 'Total reserved ' + fmtLen(v.over.total) + ' vs balance ' + fmtLen(v.over.balance)
    });
    if (v.wo.opStatus === 'OPEN') {
      v.wo.opStatus = 'IN_PROGRESS';
      SharedRepo._patch('work_orders', 'id=eq.' + encodeURIComponent(v.wo.id),
        { status: 'IN_PROGRESS' }).catch(function () {});
    }
    DB.save();
    return { ok: true, rec: rec, compat: v.compat, over: v.over };
  },

  releaseAssignment: function (assignId, by) {
    return SharedRepo.releaseInventory(assignId, by || DB.data.currentEmployee)
      .then(function (r) {
        var rec = (FG().inventoryAssignments || []).filter(function (a) { return a.id === assignId; })[0];
        if (rec && rec.status === 'RESERVED') {
          rec.status = 'RELEASED';
          rec.releasedAt = new Date().toISOString();
          rec.releasedBy = by || DB.data.currentEmployee;
          logAssignEvent('INVENTORY_RELEASED', {
            user: rec.releasedBy, workOrderId: rec.workOrderId, lineId: rec.lineId,
            rollId: rec.rollId, assignmentId: rec.id,
            detail: 'Released ' + fmtLen(rec.reservedIn) + ' reservation'
          });
          DB.save();
        }
        return { ok: true, rec: r.rec };
      });
  }
};
