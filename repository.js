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
          color: l.color || '', uom: 'LF', widthIn: l.width_in, requiredIn: l.required_in,
          requiredCount: l.required_count != null ? Number(l.required_count) : null
        };
      });
    /* The WO detail screen renders flattened top-level material fields, so
       mirror the first material line (same convention as the local v2->v3
       migration). */
    var first = ls[0] || {};
    return {
      id: w.id, number: w.number, property: w.property || '', account: w.account || '',
      style: first.style || '', color: first.color || '', materialType: first.materialType || '',
      uom: first.uom || 'LF', widthIn: first.widthIn || null,
      quantity: first.requiredCount != null ? first.requiredCount : (first.requiredIn || 0),
      opStatus: w.status || 'OPEN',
      assignmentStatus: w.assignment_status || 'UNASSIGNED',
      assigneeId: w.assignee_id || null,
      scheduledDate: w.scheduled_date || null, scheduledTime: w.scheduled_time || null,
      priority: w.priority || 'NORMAL',
      onHold: !!w.on_hold, holdReason: w.hold_reason || null, holdAt: w.hold_at || null,
      holdBy: w.hold_by || null,
      warehouseCompletedAt: w.warehouse_completed_at || null,
      warehouseCompletedBy: w.warehouse_completed_by || null,
      salesOrderId: w.sales_order_id || null,
      salesOrderLineId: w.sales_order_line_id || null,
      notes: w.notes || '',
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
      scheduled_date: wo.scheduledDate || null, scheduled_time: wo.scheduledTime || null,
      priority: wo.priority || 'NORMAL',
      on_hold: !!wo.onHold, hold_reason: wo.holdReason || null,
      hold_at: wo.holdAt || null, hold_by: wo.holdBy || null,
      warehouse_completed_at: wo.warehouseCompletedAt || null,
      warehouse_completed_by: wo.warehouseCompletedBy || null,
      sales_order_id: wo.salesOrderId || null,
      sales_order_line_id: wo.salesOrderLineId || null,
      notes: wo.notes || null
    };
  },
  lineToRow: function (line, workOrderId) {
    return {
      id: line.id, work_order_id: workOrderId,
      material_type: line.materialType || null, style: line.style || null,
      color: line.color || null, width_in: line.widthIn || null,
      required_in: line.requiredIn || 0,
      required_count: line.requiredCount != null ? line.requiredCount : null
    };
  },
  /* ---- Run 6: orders / order items / sales orders / sales order lines ---- */
  rowToOrder: function (r, itemRows) {
    var items = (itemRows || []).filter(function (i) { return i.order_id === r.id; })
      .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); })
      .map(function (i) {
        return {
          id: i.id, seq: i.seq, style: i.style || '', color: i.color || '',
          materialType: (i.material_type || '').toUpperCase(), uom: i.uom || 'LF',
          widthIn: i.width_in, quantityIn: i.quantity_in,
          quantity: i.quantity != null ? Number(i.quantity) : null,
          notes: i.notes || ''
        };
      });
    return {
      id: r.id, number: r.number, property: r.property || '', account: r.account || '',
      requestedDate: r.requested_date || null, scheduledDate: r.scheduled_date || null,
      priority: r.priority || 'NORMAL', createdBy: r.created_by || '',
      warehouseId: r.warehouse_id, internalRef: r.internal_ref || '', notes: r.notes || '',
      status: r.status || 'DRAFT', items: items,
      createdAt: r.created_at, updatedAt: r.updated_at,
      submittedAt: r.submitted_at || null, salesOrderId: r.sales_order_id || null
    };
  },
  orderToRow: function (o) {
    return {
      id: o.id, number: o.number, warehouse_id: o.warehouseId,
      property: o.property || null, account: o.account || null,
      requested_date: o.requestedDate || null, scheduled_date: o.scheduledDate || null,
      priority: o.priority || 'NORMAL', created_by: o.createdBy || null,
      internal_ref: o.internalRef || null, notes: o.notes || null,
      status: o.status || 'DRAFT', sales_order_id: o.salesOrderId || null,
      submitted_at: o.submittedAt || null
    };
  },
  itemToRow: function (it, orderId) {
    return {
      id: it.id, order_id: orderId, seq: it.seq,
      style: it.style || null, color: it.color || null,
      material_type: it.materialType || null, uom: it.uom || 'LF',
      width_in: it.widthIn != null ? it.widthIn : null,
      quantity_in: it.quantityIn != null ? it.quantityIn : null,
      quantity: it.quantity != null ? it.quantity : null,
      notes: it.notes || null
    };
  },
  rowToSalesOrder: function (r, lineRows) {
    var lines = (lineRows || []).filter(function (l) { return l.sales_order_id === r.id; })
      .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); })
      .map(function (l) {
        return {
          id: l.id, seq: l.seq, sourceItemId: l.source_item_id || null,
          style: l.style || '', color: l.color || '',
          materialType: (l.material_type || '').toUpperCase(), uom: l.uom || 'LF',
          widthIn: l.width_in, orderedIn: l.ordered_in,
          orderedQty: l.ordered_qty != null ? Number(l.ordered_qty) : null,
          warehouseQtyRequired: l.warehouse_qty_required != null ? Number(l.warehouse_qty_required) : null,
          status: l.status || 'OPEN', workOrderId: l.work_order_id || null
        };
      });
    return {
      id: r.id, number: r.number, sourceOrderId: r.source_order_id || null,
      property: r.property || '', account: r.account || '',
      warehouseId: r.warehouse_id, priority: r.priority || 'NORMAL',
      requestedDate: r.requested_date || null, scheduledDate: r.scheduled_date || null,
      status: r.status || 'OPEN', createdBy: r.created_by || '',
      submittedBy: r.submitted_by || '', notes: r.notes || '',
      onHold: !!r.on_hold, holdReason: r.hold_reason || null,
      holdAt: r.hold_at || null, holdBy: r.hold_by || null,
      createdAt: r.created_at, submittedAt: r.submitted_at || null,
      updatedAt: r.updated_at, lines: lines
    };
  },
  /* ---- Run 7: loadouts ---- */
  rowToLoadout: function (lo, lineRows, exRows) {
    var lines = (lineRows || []).filter(function (l) { return l.loadout_id === lo.id; })
      .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); })
      .map(function (l) {
        return {
          id: l.id, seq: l.seq, style: l.style || '', color: l.color || '',
          materialType: (l.material_type || '').toUpperCase(), uom: l.uom || 'LF',
          widthIn: l.width_in, requiredIn: l.required_in,
          requiredCount: l.required_count != null ? Number(l.required_count) : null,
          preparedIn: l.prepared_in, rollId: l.roll_id || null, barcode: l.barcode || null,
          status: l.status || 'WAITING',
          verifiedBy: l.verified_by || null, verifiedAt: l.verified_at || null,
          loadedBy: l.loaded_by || null, loadedAt: l.loaded_at || null
        };
      });
    var exs = (exRows || []).filter(function (e) { return e.loadout_id === lo.id; })
      .map(function (e) {
        return { id: e.id, loadoutId: e.loadout_id, lineId: e.line_id || null,
          type: e.type, notes: e.notes || '', by: e.created_by || '', at: e.created_at };
      });
    return {
      id: lo.id, number: lo.number, workOrderId: lo.work_order_id || null,
      salesOrderId: lo.sales_order_id || null, warehouseId: lo.warehouse_id,
      property: lo.property || '', account: lo.account || '',
      status: lo.status || 'READY', priority: lo.priority || 'NORMAL',
      startedBy: lo.started_by || null, startedAt: lo.started_at || null,
      completedBy: lo.completed_by || null, completedAt: lo.completed_at || null,
      onHold: !!lo.on_hold, holdReason: lo.hold_reason || null,
      notes: lo.notes || '', clientRequestKey: lo.client_request_key || null,
      createdAt: lo.created_at, updatedAt: lo.updated_at,
      lines: lines, exceptions: exs
    };
  },
  /* ---- Run 7: receipts ---- */
  rowToReceipt: function (r, lineRows, exRows) {
    var lines = (lineRows || []).filter(function (l) { return l.receipt_id === r.id; })
      .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); })
      .map(function (l) {
        return {
          id: l.id, seq: l.seq,
          materialType: (l.material_type || '').toUpperCase(), uom: l.uom || 'LF',
          style: l.style || '', color: l.color || '', manufacturer: l.manufacturer || '',
          widthIn: l.width_in,
          expectedQtyIn: l.expected_qty_in,
          expectedQty: l.expected_qty != null ? Number(l.expected_qty) : null,
          receivedQtyIn: l.received_qty_in,
          receivedQty: l.received_qty != null ? Number(l.received_qty) : null,
          rollId: l.roll_id || null, barcode: l.barcode || null,
          location: l.location_code || '', status: l.status || 'EXPECTED',
          exception: l.exception || null,
          receivedBy: l.received_by || null, receivedAt: l.received_at || null,
          clientRequestId: l.client_request_key || null
        };
      });
    var exs = (exRows || []).filter(function (e) { return e.receipt_id === r.id; })
      .map(function (e) {
        return { id: e.id, receiptId: e.receipt_id, lineId: e.line_id || null,
          type: e.type, notes: e.notes || '', by: e.created_by || '', at: e.created_at };
      });
    return {
      id: r.id, number: r.number, warehouseId: r.warehouse_id,
      supplier: r.supplier || '', referenceNumber: r.reference_number || '',
      status: r.status || 'EXPECTED',
      expectedDate: r.expected_date || null, notes: r.notes || '',
      createdBy: r.created_by || '', createdAt: r.created_at,
      completedBy: r.completed_by || null, completedAt: r.completed_at || null,
      clientRequestKey: r.client_request_key || null,
      lines: lines, exceptions: exs
    };
  },
  /* ---- Run 8: returns ---- */
  rowToReturnItem: function (i) {
    return {
      id: i.id, returnId: i.return_id, warehouse: i.warehouse_id,
      materialType: (i.material_type || '').toUpperCase(), productId: i.product_id || null,
      rollId: i.roll_id || null, sourceAssignmentId: i.source_inventory_assignment_id || null,
      sourceLoadoutLineId: i.source_loadout_line_id || null,
      style: i.style || null, color: i.color || null, widthIn: i.width_in,
      uom: i.uom || 'IN', returnedQuantity: i.returned_quantity,
      measuredIn: i.measured_in, measuredBy: i.measured_by || null, measuredAt: i.measured_at || null,
      condition: i.condition || null, disposition: i.disposition || null,
      status: i.status || 'PENDING', locationCode: i.location_code || null,
      notes: i.notes || null, createdAt: i.created_at, updatedAt: i.updated_at,
      requestKey: i.client_request_key || null
    };
  },
  rowToReturn: function (r, itemRows, exRows) {
    var items = (itemRows || []).filter(function (i) { return i.return_id === r.id; })
      .map(Mappers.rowToReturnItem);
    var exs = (exRows || []).filter(function (e) { return e.return_id === r.id; })
      .map(Mappers.rowToReturnException);
    return {
      id: r.id, number: r.return_number, warehouse: r.warehouse_id,
      workOrderId: r.work_order_id || null, salesOrderId: r.sales_order_id || null,
      loadoutId: r.loadout_id || null, property: r.property || null, account: r.account || null,
      sourceKind: r.source_kind || 'MANUAL', reason: r.reason || 'OTHER',
      status: r.status || 'PENDING', notes: r.notes || null,
      createdBy: r.created_by || '', receivedBy: r.received_by || null,
      createdAt: r.created_at, receivedAt: r.received_at || null,
      completedAt: r.completed_at || null, updatedAt: r.updated_at,
      requestKey: r.client_request_key || null,
      items: items, exceptions: exs
    };
  },
  rowToReturnDisposition: function (d) {
    return {
      id: d.id, returnId: d.return_id, returnItemId: d.return_item_id,
      disposition: d.disposition, decidedBy: d.decided_by || '', approvedBy: d.approved_by || null,
      reason: d.reason || null, locationCode: d.location_code || null,
      previousBalanceIn: d.previous_balance_in, quantityIn: d.quantity_in,
      newBalanceIn: d.new_balance_in, vendorSupplier: d.vendor_supplier || null,
      vendorReference: d.vendor_reference || null, vendorStatus: d.vendor_status || null,
      at: d.created_at, requestKey: d.client_request_key || null
    };
  },
  rowToReturnedRemnant: function (m) {
    return {
      id: m.id, number: m.remnant_number, parentRollId: m.parent_roll_id || null,
      returnId: m.return_id, returnItemId: m.return_item_id || null,
      materialType: (m.material_type || '').toUpperCase(), style: m.style || null,
      color: m.color || null, widthIn: m.width_in, lengthIn: m.length_in,
      condition: m.condition || null, locationCode: m.location_code || null,
      status: m.status || 'AVAILABLE', createdBy: m.created_by || '',
      createdAt: m.created_at, updatedAt: m.updated_at,
      requestKey: m.client_request_key || null
    };
  },
  rowToReturnException: function (e) {
    return {
      id: e.id, returnId: e.return_id, returnItemId: e.return_item_id || null,
      kind: e.kind, detail: e.detail || null, status: e.status || 'OPEN',
      raisedBy: e.raised_by || '', resolvedBy: e.resolved_by || null,
      resolvedAt: e.resolved_at || null, createdAt: e.created_at
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
    var isReturn = !!r.return_id;
    return {
      id: r.id, rollId: r.roll_id || null, receiptId: r.receipt_id || null,
      returnId: r.return_id || null,
      kind: isReturn ? 'RETURN_DOCUMENT' : (r.receipt_id ? 'RECEIPT_DOCUMENT' : 'HISTORY_CARD'),
      docType: r.document_type || 'HISTORY CARD',
      employee: r.employee_name || '', at: r.captured_at,
      location: r.location_code || null, sessionId: r.session_id || null,
      storagePath: r.storage_path, image: null, thumb: null,
      imports: [], source: 'PAPER CARD'
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
  assignRemnantInventory: function (o) { return Promise.resolve(assignRemnantInventoryLocal(o)); },
  releaseInventory: function (assignId, by) { return Promise.resolve(releaseAssignment(assignId, by)); },
  /* ---- Run 5: scheduled jobs / daily warehouse queue ---- */
  getScheduledJobs: function () { return Promise.resolve(scheduledJobs()); },
  getJobsForDate: function (ds) { return Promise.resolve(jobsForDate(ds)); },
  getMyScheduledJobs: function () { return Promise.resolve(myScheduledJobs()); },
  setJobHold: function (woId, reason) { return Promise.resolve(setJobHoldLocal(woId, reason)); },
  resumeJob: function (woId) { return Promise.resolve(resumeJobLocal(woId)); },
  startWarehouseWork: function (woId) { return Promise.resolve(startWarehouseWorkLocal(woId)); },
  assignEmployee: function (woId, assigneeId) { return Promise.resolve(assignEmployeeLocal(woId, assigneeId)); },
  completeWarehouseWork: function (woId) { return Promise.resolve(completeWarehouseWorkLocal(woId)); },
  addWorkOrderNote: function (woId, text) { return Promise.resolve(addWorkOrderNoteLocal(woId, text)); },
  /* ---- Run 6: order + sales order foundation ---- */
  createOrder: function (h) { return Promise.resolve(createOrderLocal(h)); },
  getOrder: function (id) { return Promise.resolve(orderById(id)); },
  updateOrderHeader: function (id, patch) { return Promise.resolve(updateOrderHeaderLocal(id, patch)); },
  addOrderItem: function (id, it) { return Promise.resolve(addOrderItemLocal(id, it)); },
  updateOrderItem: function (id, itemId, patch) { return Promise.resolve(updateOrderItemLocal(id, itemId, patch)); },
  removeOrderItem: function (id, itemId) { return Promise.resolve(removeOrderItemLocal(id, itemId)); },
  deleteOrder: function (id) { return Promise.resolve(deleteOrderLocal(id)); },
  getDraftOrders: function () { return Promise.resolve(getDraftOrdersLocal()); },
  getRecentSubmittedOrders: function (n) { return Promise.resolve(getRecentSubmittedOrdersLocal(n)); },
  markOrderReady: function (id) { return Promise.resolve(markOrderReadyLocal(id)); },
  submitOrder: function (id) { return Promise.resolve(submitOrderLocal(id)); },
  getSalesOrders: function () { return Promise.resolve(getSalesOrdersLocal()); },
  getSalesOrder: function (id) { return Promise.resolve(salesOrderById(id)); },
  releaseSalesOrderLine: function (soId, lineId) { return Promise.resolve(releaseSalesOrderLineLocal(soId, lineId)); },
  holdSalesOrder: function (soId, reason) { return Promise.resolve(holdSalesOrderLocal(soId, reason)); },
  resumeSalesOrder: function (soId) { return Promise.resolve(resumeSalesOrderLocal(soId)); },
  cancelSalesOrder: function (soId, reason, opts) { return Promise.resolve(cancelSalesOrderLocal(soId, reason, opts)); },
  /* ---- Run 6 §0: reopen a completed warehouse job ---- */
  reopenWarehouseWork: function (woId, reason) { return Promise.resolve(reopenWarehouseWorkLocal(woId, reason)); },
  /* ---- Run 7: loadout + receipts (local simulated central numbering) ---- */
  issueBusinessNumber: function (kind, requestKey) {
    /* Local Demo simulates the central issuer: same kind vocabulary as the
       backend, idempotent on the request key. */
    var map = { ORD: 'order', SO: 'sales_order', WO: 'work_order', RCV: 'receipt', LOAD: 'loadout' };
    var seen = LocalRepo._numKeys || (LocalRepo._numKeys = {});
    if (requestKey && seen[requestKey]) return Promise.resolve(seen[requestKey]);
    var n = nextLocalBusinessNumber(map[kind] || kind);
    if (requestKey) seen[requestKey] = n;
    return Promise.resolve(n);
  },
  getLoadouts: function () { return Promise.resolve(getLoadoutsLocal()); },
  getLoadout: function (id) { return Promise.resolve(loadoutById(id)); },
  startLoadout: function (woId) { return Promise.resolve(startLoadoutLocal(woId)); },
  beginLoading: function (loId) { return Promise.resolve(beginLoadingLocal(loId)); },
  verifyLoadoutLine: function (loId, lineId, code) { return Promise.resolve(verifyLoadoutLineLocal(loId, lineId, code)); },
  markLoadoutLineLoaded: function (loId, lineId) { return Promise.resolve(markLoadoutLineLoadedLocal(loId, lineId)); },
  createLoadoutException: function (loId, lineId, type, notes) { return Promise.resolve(createLoadoutExceptionLocal(loId, lineId, type, notes)); },
  completeLoadout: function (loId) { return Promise.resolve(completeLoadoutLocal(loId)); },

  /* ================= Run 8: Returns + Returned Material Disposition ============ */
  getReturns: function () { return Promise.resolve((FG().returns || []).slice()); },
  getReturn: function (id) { return Promise.resolve(returnById(id)); },
  getReturnItems: function (returnId) { return Promise.resolve(returnItemsFor(returnId)); },
  getReturnItem: function (id) { return Promise.resolve(returnItemById(id)); },
  getReturnDispositions: function (itemId) { return Promise.resolve(returnDispositionsFor(itemId)); },
  getReturnedRemnants: function (returnId) { return Promise.resolve(remnantsForReturn(returnId)); },
  getAvailableRemnants: function () { return Promise.resolve(availableRemnants()); },
  getReturnExceptions: function (returnId) { return Promise.resolve(returnExceptionsFor(returnId)); },
  createReturn: function (o) { return Promise.resolve(createReturnLocal(o)); },
  receiveReturn: function (id) {
    /* Accept id string or { id } object (UI passes { id }). */
    var rid = (id && typeof id === 'object') ? id.id : id;
    return Promise.resolve(receiveReturnLocal(rid));
  },
  addReturnItem: function (returnId, it) { return Promise.resolve(addReturnItemLocal(returnId, it)); },
  measureReturnItem: function (itemId, inches) { return Promise.resolve(measureReturnItemLocal(itemId, inches)); },
  inspectReturnItem: function (itemId, condition, notes) { return Promise.resolve(inspectReturnItemLocal(itemId, condition, notes)); },
  submitReturn: function (id) { return Promise.resolve(submitReturnLocal(id)); },
  approveRestock: function (itemId, o) { return Promise.resolve(approveRestockLocal(itemId, o)); },
  createReturnedRemnant: function (itemId, o) { return Promise.resolve(createReturnedRemnantLocal(itemId, o)); },
  quarantineReturnItem: function (itemId, o) { return Promise.resolve(quarantineReturnItemLocal(itemId, o)); },
  scrapReturnItem: function (itemId, o) { return Promise.resolve(scrapReturnItemLocal(itemId, o)); },
  sendReturnToVendor: function (itemId, o) { return Promise.resolve(sendReturnToVendorLocal(itemId, o)); },
  holdReturnItem: function (itemId, reason) { return Promise.resolve(holdReturnItemLocal(itemId, reason)); },
  completeReturn: function (id) { return Promise.resolve(completeReturnLocal(id)); },
  cancelReturn: function (id, reason) { return Promise.resolve(cancelReturnLocal(id, reason)); },
  raiseReturnException: function (returnId, o) { return Promise.resolve(raiseReturnExceptionLocal(returnId, o)); },
  resolveReturnException: function (exceptionId, resolution) { return Promise.resolve(resolveReturnExceptionLocal(exceptionId, resolution)); },
  uploadReturnDocument: function (o) {
    /* o: {returnId, docType, imageDataUrl, thumbDataUrl, mimeType, employee} */
    var now = new Date();
    var r = returnById(o.returnId);
    var rec = {
      id: rid('D'), rollId: null, barcode: null, raw: null, discovered: false,
      kind: 'RETURN_DOCUMENT', docType: o.docType || 'RETURN CONDITION PHOTO',
      image: o.imageDataUrl || null, thumb: o.thumbDataUrl || o.imageDataUrl || null,
      employee: o.employee || DB.data.currentEmployee,
      at: now.toISOString(), date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
      location: null, source: 'LOCAL',
      num: returnDocuments(o.returnId).length + 1,
      imports: [], returnId: o.returnId, sessionId: null
    };
    FG().documents.push(rec);
    DB.save();
    logReturnEvent('DOCUMENT_CAPTURED', { returnId: o.returnId, returnNumber: r && r.number,
      workOrderId: r && r.workOrderId, salesOrderId: r && r.salesOrderId,
      detail: rec.docType + ' captured by ' + rec.employee + '.' });
    return Promise.resolve({ ok: true, doc: rec });
  },
  getDocumentsForReturn: function (returnId) {
    return Promise.resolve(returnDocuments(returnId));
  },
  /* local remnant reads feed Assign Inventory */
  getRemnantById: function (id) { return Promise.resolve(remnantById(id)); },
  /* ================= end Run 8 (local) ============ */
  getReceipts: function () { return Promise.resolve(getReceiptsLocal()); },
  getReceipt: function (id) { return Promise.resolve(receiptById(id)); },
  createReceipt: function (o) { return Promise.resolve(createReceiptLocal(o)); },
  addReceiptLine: function (rcId, line) { return Promise.resolve(addReceiptLineLocal(rcId, line)); },
  receiveRoll: function (rcId, o) { return Promise.resolve(receiveRollLocal(rcId, o)); },
  createReceiptException: function (rcId, type, notes) { return Promise.resolve(createReceiptExceptionLocal(rcId, type, notes)); },
  completeReceipt: function (rcId) { return Promise.resolve(completeReceiptLocal(rcId)); },
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
  deleteOrder: function (id) {
    var self = this;
    self._requireOnline('OFFLINE — DRAFT NOT DISCARDED');
    self._requireOrderPolicy(orderPolicy().canCreateOrder, 'Manager role required.');
    var o = orderById(id);
    if (!o) throw RepoError('NOT_FOUND', 'Order not found.');
    if (o.status !== 'DRAFT' && o.status !== 'READY_FOR_REVIEW')
      throw RepoError('INVALID_INPUT', 'Only drafts can be discarded.');
    return pgFetch('/rest/v1/orders?id=eq.' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () {
        FG().orders = (FG().orders || []).filter(function (x) { return x.id !== id; });
        DB.save();
        logOrderEvent('ORDER_DISCARDED', { orderId: id, orderNumber: o.number,
          detail: 'Draft ' + o.number + ' discarded by ' + DB.data.currentEmployee + '.' });
        return { ok: true };
      });
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
  uploadReceiptDocument: function (o) {
    /* o: {receiptId, imageDataUrl, thumbDataUrl, mimeType, employee} */
    var now = new Date();
    var rec = {
      id: rid('D'), rollId: null, barcode: null, raw: null, discovered: false,
      kind: 'RECEIPT_DOCUMENT', docType: 'RECEIVING DOCUMENT',
      image: o.imageDataUrl || null, thumb: o.thumbDataUrl || o.imageDataUrl || null,
      employee: o.employee || DB.data.currentEmployee,
      at: now.toISOString(), date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
      location: null, source: 'LOCAL', num: receiptDocuments(o.receiptId).length + 1,
      imports: [], receiptId: o.receiptId, sessionId: null
    };
    FG().documents.push(rec);
    DB.save();
    return Promise.resolve({ ok: true, doc: rec });
  },
  getDocumentsForReceipt: function (receiptId) {
    return Promise.resolve(receiptDocuments(receiptId));
  },
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

  /* ---- Run 5: scheduled jobs / daily warehouse queue ----
     Reads: refresh the hydrated mirror (cached queue is acceptable
     offline), then derive from the in-memory store — the same derivation
     local mode uses. Writes: validate with local rules, PATCH the
     work_orders row, append an audit_events row, then mirror locally so
     screens re-render instantly. Offline writes fail fast via pgFetch's
     preflight — a hold/completion/assignment/note NEVER pretends to sync. */
  _refreshJobs: function () {
    var self = this;
    return self.hydrate().catch(function () { return null; /* offline: use cached */ })
      .then(function () { return true; });
  },
  getScheduledJobs: function () {
    return this._refreshJobs().then(function () { return scheduledJobs(); });
  },
  getJobsForDate: function (ds) {
    return this._refreshJobs().then(function () { return jobsForDate(ds); });
  },
  getMyScheduledJobs: function () {
    return this._refreshJobs().then(function () { return myScheduledJobs(); });
  },
  _woAudit: function (action, wo, extra) {
    var e = {
      id: rid('A'), user_id: null, user_name: DB.data.currentEmployee || null,
      warehouse_id: this.wh(), action: action, entity_type: 'work_order',
      entity_id: wo.id, related_work_order_id: wo.id, related_roll_id: null,
      old_value: null, new_value: extra || null, created_at: isoNow()
    };
    return this._post('audit_events', [e]).then(function () { return e; });
  },
  _validateJobWrite: function (woId, needSupervisor) {
    var w = woById(woId);
    if (!w) throw RepoError('NOT_FOUND', 'Work order not found.');
    if (needSupervisor && !isSupervisorRole(DB.data.currentEmployee))
      throw RepoError('FORBIDDEN', 'Supervisor role required.');
    return w;
  },
  setJobHold: function (woId, reason) {
    var self = this;
    var w = self._validateJobWrite(woId, true);
    if (w.onHold) throw RepoError('INVALID_INPUT', 'Job is already on hold.');
    reason = String(reason || 'OTHER').toUpperCase();
    var patch = { on_hold: true, hold_reason: reason, hold_at: isoNow(), hold_by: DB.data.currentEmployee };
    return self._patch('work_orders', 'id=eq.' + encodeURIComponent(woId), patch)
      .then(function () { return self._woAudit('JOB_HELD', w, { reason: reason }); })
      .then(function () {
        w.onHold = true; w.holdReason = reason; w.holdAt = patch.hold_at; w.holdBy = patch.hold_by;
        DB.save();
        logAssignEvent('JOB_HELD', { workOrderId: w.id, detail: 'Job placed ON HOLD: ' + reason });
        return { ok: true, workOrder: w };
      });
  },
  resumeJob: function (woId) {
    var self = this;
    var w = self._validateJobWrite(woId, true);
    if (!w.onHold) throw RepoError('INVALID_INPUT', 'Job is not on hold.');
    var patch = { on_hold: false, hold_reason: null, hold_at: null, hold_by: null };
    return self._patch('work_orders', 'id=eq.' + encodeURIComponent(woId), patch)
      .then(function () { return self._woAudit('JOB_RESUMED', w, null); })
      .then(function () {
        w.onHold = false; w.holdReason = null; w.holdAt = null; w.holdBy = null;
        DB.save();
        logAssignEvent('JOB_RESUMED', { workOrderId: w.id, detail: 'Job resumed from hold.' });
        return { ok: true, workOrder: w };
      });
  },
  startWarehouseWork: function (woId) {
    var self = this;
    var w = self._validateJobWrite(woId, false);
    if (w.onHold) throw RepoError('INVALID_INPUT', 'Job is on hold.');
    return self._patch('work_orders', 'id=eq.' + encodeURIComponent(woId), { status: 'IN_PROGRESS' })
      .then(function () { return self._woAudit('WAREHOUSE_WORK_STARTED', w, null); })
      .then(function () {
        w.opStatus = 'IN_PROGRESS';
        w.startedAt = w.startedAt || isoNow(); w.startedBy = w.startedBy || DB.data.currentEmployee;
        DB.save();
        logAssignEvent('WAREHOUSE_WORK_STARTED', { workOrderId: w.id, detail: 'Warehouse work started.' });
        return { ok: true, workOrder: w };
      });
  },
  assignEmployee: function (woId, assigneeId) {
    var self = this;
    var w = self._validateJobWrite(woId, false);
    return self._patch('work_orders', 'id=eq.' + encodeURIComponent(woId), { assignee_id: assigneeId || null })
      .then(function () { return self._woAudit('EMPLOYEE_ASSIGNED', w, { assignee_id: assigneeId || null }); })
      .then(function () {
        w.assigneeId = assigneeId || null;
        DB.save();
        var nm = woAssigneeName(w);
        logAssignEvent('EMPLOYEE_ASSIGNED', { workOrderId: w.id,
          detail: nm ? 'Assigned to ' + nm + '.' : 'Unassigned.' });
        return { ok: true, workOrder: w };
      });
  },
  completeWarehouseWork: function (woId) {
    var self = this;
    /* Run 6 §0: the assigned employee may complete their own job;
       supervisor / manager / admin may complete any job. */
    var w = self._validateJobWrite(woId, false);
    if (!isSupervisorRole(DB.data.currentEmployee) && !isWoAssignee(w))
      throw RepoError('FORBIDDEN', 'Not authorized to complete this job.');
    if (w.onHold) throw RepoError('INVALID_INPUT', 'Job is on hold.');
    /* Guard against fresh backend state: hydrate first, then run the same
       completion guard local mode uses. */
    return self._refreshJobs().then(function () {
      var fresh = woById(woId);
      if (!fresh) throw RepoError('NOT_FOUND', 'Work order not found.');
      /* Run 6: count-based lines have no cut-based verification engine —
         a plain assignee cannot self-certify them. */
      var isSup = isSupervisorRole(DB.data.currentEmployee);
      var countLines = woCountBasedLines(fresh);
      if (!isSup && countLines.length)
        throw RepoError('FORBIDDEN', 'Count-based lines require supervisor verification.');
      var blockers = warehouseCompletionBlockers(fresh);
      if (blockers.length)
        throw RepoError('LINES_INCOMPLETE', 'Material lines incomplete.',
          { blockers: blockers.map(function (b) { return b.lineId + ':' + b.status; }) });
      var at = isoNow(), by = DB.data.currentEmployee;
      return self._patch('work_orders', 'id=eq.' + encodeURIComponent(woId),
          { status: 'COMPLETE', warehouse_completed_at: at, warehouse_completed_by: by })
        .then(function () { return self._woAudit('WAREHOUSE_WORK_COMPLETED', fresh, null); })
        .then(function () {
          fresh.opStatus = 'COMPLETE'; fresh.warehouseCompletedAt = at; fresh.warehouseCompletedBy = by;
          DB.save();
          logAssignEvent('WAREHOUSE_WORK_COMPLETED', { workOrderId: fresh.id,
            detail: 'Warehouse work completed by ' + by + '.' +
              (countLines.length ? ' (' + countLines.length + ' count-based line(s) accepted under supervisor judgment.)' : '') });
          return { ok: true, workOrder: fresh };
        });
    });
  },
  /* Run 6 §0: authorized supervisor/manager roles may reopen a completed
     warehouse job for later correction. Reason is required and audited. */
  reopenWarehouseWork: function (woId, reason) {
    var self = this;
    var w = self._validateJobWrite(woId, true);
    reason = String(reason || '').trim();
    if (!reason) throw RepoError('INVALID_INPUT', 'Reason is required.');
    if (w.opStatus !== 'COMPLETE') throw RepoError('INVALID_INPUT', 'Job is not completed.');
    return self._patch('work_orders', 'id=eq.' + encodeURIComponent(woId),
        { status: 'IN_PROGRESS', warehouse_completed_at: null, warehouse_completed_by: null })
      .then(function () { return self._woAudit('WAREHOUSE_WORK_REOPENED', w, { reason: reason }); })
      .then(function () {
        w.opStatus = 'IN_PROGRESS'; w.warehouseCompletedAt = null; w.warehouseCompletedBy = null;
        DB.save();
        logAssignEvent('WAREHOUSE_WORK_REOPENED', { workOrderId: w.id,
          detail: 'Warehouse job reopened by ' + DB.data.currentEmployee + ': ' + reason });
        return { ok: true, workOrder: w };
      });
  },
  addWorkOrderNote: function (woId, text) {
    var self = this;
    var w = self._validateJobWrite(woId, false);
    text = String(text || '').trim();
    if (!text) throw RepoError('INVALID_INPUT', 'Note is empty.');
    return self._woAudit('WORK_ORDER_NOTE_ADDED', w, { text: text })
      .then(function () {
        logAssignEvent('WORK_ORDER_NOTE_ADDED', { workOrderId: w.id, detail: text });
        return { ok: true };
      });
  },

  /* ---- Run 6: order + sales order foundation ----
     Reads: refresh the hydrated mirror (cached reads stay acceptable
     offline), then derive from the in-memory store — the same derivation
     local mode uses. Draft edits go through PostgREST directly.
     SUBMIT and RELEASE are authoritative business mutations: they execute
     inside atomic server-side RPCs and fail fast offline via pgFetch's
     preflight — they NEVER pretend to sync. UI must not call Supabase
     directly; every backend touch goes through these methods. */
  _orderAudit: function (action, refs, extra) {
    var e = {
      id: rid('A'), user_id: null, user_name: DB.data.currentEmployee || null,
      warehouse_id: this.wh(), action: action,
      entity_type: refs.salesOrderId ? 'sales_order' : 'order',
      entity_id: refs.salesOrderId || refs.orderId || null,
      related_work_order_id: refs.workOrderId || null, related_roll_id: null,
      old_value: null, new_value: extra || null, created_at: isoNow()
    };
    return this._post('audit_events', [e]).then(function () { return e; });
  },
  _refreshOrders: function () {
    var self = this;
    return self.hydrate().catch(function () { return null; /* offline: use cached */ })
      .then(function () { return true; });
  },
  _requireOrderPolicy: function (can, errMsg) {
    if (!can) throw RepoError('FORBIDDEN', errMsg || 'Not authorized for this action.');
  },
  /* Run 6 §24/§29: offline mutations fail fast with the exact spec phrases —
     never a misleading NOT_FOUND / NETWORK error, and never a silent queue. */
  _requireOnline: function (offlineMsg) {
    if (!isOnline()) throw RepoError('OFFLINE', offlineMsg || 'OFFLINE — not synced.');
  },
  createOrder: function (h) {
    var self = this;
    self._requireOnline('OFFLINE — ORDER NOT CREATED');
    self._requireOrderPolicy(orderPolicy().canCreateOrder, 'Manager role required.');
    var err = validateOrderHeader(h || {});
    if (err) throw RepoError('INVALID_INPUT', err);
    h = h || {};
    var now = isoNow();
    var o = {
      id: rid('ORD'), number: null, /* issued by the backend below */
      property: String(h.property).trim(),
      account: String(h.account || accountForProperty(h.property) || '').trim(),
      requestedDate: h.requestedDate || null, scheduledDate: h.scheduledDate || null,
      priority: h.priority || 'NORMAL', createdBy: DB.data.currentEmployee,
      warehouseId: self.wh(), internalRef: String(h.internalRef || '').trim(),
      notes: String(h.notes || '').trim(), status: 'DRAFT', items: [],
      createdAt: now, updatedAt: now, submittedAt: null, salesOrderId: null
    };
    /* Run 7: atomic create_order RPC — the ORD number is issued inside the
       same transaction that inserts the order, so a failed insert can never
       burn a number and a retried create returns the existing order. */
    return self._rpc('create_order', {
        p_order_id: o.id, p_warehouse_id: o.warehouseId, p_property: o.property,
        p_account: o.account, p_requested_date: o.requestedDate,
        p_scheduled_date: o.scheduledDate, p_priority: o.priority,
        p_created_by: o.createdBy, p_internal_ref: o.internalRef, p_notes: o.notes
      })
      .then(self._rpcResult)
      .then(function (res) {
        o.number = res.number;
        return self._refreshOrders().then(function () {
          var created = orderById(o.id) || o;
          logOrderEvent('ORDER_CREATED', { orderId: o.id, orderNumber: o.number });
          return { ok: true, order: created, duplicate: !!res.duplicate };
        });
      });
  },
  getOrder: function (id) {
    var self = this;
    return self._refreshOrders().then(function () { return orderById(id); });
  },
  getDraftOrders: function () {
    var self = this;
    return self._refreshOrders().then(function () { return getDraftOrdersLocal(); });
  },
  getRecentSubmittedOrders: function (n) {
    var self = this;
    return self._refreshOrders().then(function () { return getRecentSubmittedOrdersLocal(n); });
  },
  updateOrderHeader: function (id, patch) {
    var self = this;
    self._requireOnline('OFFLINE — ORDER NOT UPDATED');
    self._requireOrderPolicy(orderPolicy().canCreateOrder, 'Manager role required.');
    var o = orderById(id);
    if (!o) throw RepoError('NOT_FOUND', 'Order not found.');
    if (!orderEditable(o)) throw RepoError('INVALID_INPUT', 'Order is not editable.');
    var merged = { property: o.property, account: o.account, requestedDate: o.requestedDate,
      scheduledDate: o.scheduledDate, priority: o.priority, internalRef: o.internalRef, notes: o.notes };
    ['property', 'account', 'requestedDate', 'scheduledDate', 'priority', 'internalRef', 'notes'].forEach(function (k) {
      if (patch && k in patch) merged[k] = patch[k];
    });
    var err = validateOrderHeader(merged);
    if (err) throw RepoError('INVALID_INPUT', err);
    var rowPatch = {
      property: String(merged.property).trim(), account: String(merged.account || '').trim() || null,
      requested_date: merged.requestedDate || null, scheduled_date: merged.scheduledDate || null,
      priority: merged.priority || 'NORMAL',
      internal_ref: String(merged.internalRef || '').trim() || null,
      notes: String(merged.notes || '').trim() || null, updated_at: isoNow()
    };
    return self._patch('orders', 'id=eq.' + encodeURIComponent(id), rowPatch).then(function () {
      o.property = rowPatch.property; o.account = String(merged.account || '').trim();
      o.requestedDate = merged.requestedDate || null; o.scheduledDate = merged.scheduledDate || null;
      o.priority = merged.priority || 'NORMAL';
      o.internalRef = String(merged.internalRef || '').trim(); o.notes = String(merged.notes || '').trim();
      o.updatedAt = rowPatch.updated_at;
      DB.save();
      logOrderEvent('ORDER_HEADER_UPDATED', { orderId: o.id, orderNumber: o.number });
      return { ok: true, order: o };
    });
  },
  addOrderItem: function (id, it) {
    var self = this;
    self._requireOnline('OFFLINE — ORDER ITEM NOT ADDED');
    self._requireOrderPolicy(orderPolicy().canCreateOrder, 'Manager role required.');
    var o = orderById(id);
    if (!o) throw RepoError('NOT_FOUND', 'Order not found.');
    if (!orderEditable(o)) throw RepoError('INVALID_INPUT', 'Order is not editable.');
    var err = validateOrderItem(it || {});
    if (err) throw RepoError('INVALID_INPUT', err);
    it = it || {};
    var rec = {
      id: rid('OI'), seq: (o.items || []).length + 1,
      style: String(it.style).trim(), color: String(it.color || '').trim(),
      materialType: it.materialType, uom: it.uom,
      widthIn: it.widthIn != null && it.widthIn !== '' ? Math.round(Number(it.widthIn)) : null,
      quantityIn: it.uom === 'LF' ? Math.round(Number(it.quantityIn)) : null,
      quantity: it.uom === 'LF' ? null : Number(it.quantity),
      notes: String(it.notes || '').trim()
    };
    return self._post('order_items', [Mappers.itemToRow(rec, id)])
      .then(function () { return self._orderAudit('ORDER_ITEM_ADDED', { orderId: id }, { item_id: rec.id }); })
      .then(function () {
        o.items.push(rec); o.updatedAt = isoNow(); DB.save();
        logOrderEvent('ORDER_ITEM_ADDED', { orderId: o.id, orderNumber: o.number,
          detail: rec.style + ' · ' + orderItemQtyDisplay(rec) });
        return { ok: true, order: o, item: rec };
      });
  },
  updateOrderItem: function (id, itemId, patch) {
    var self = this;
    self._requireOnline('OFFLINE — ORDER ITEM NOT UPDATED');
    self._requireOrderPolicy(orderPolicy().canCreateOrder, 'Manager role required.');
    var o = orderById(id);
    if (!o) throw RepoError('NOT_FOUND', 'Order not found.');
    if (!orderEditable(o)) throw RepoError('INVALID_INPUT', 'Order is not editable.');
    var rec = orderItemById(o, itemId);
    if (!rec) throw RepoError('NOT_FOUND', 'Item not found.');
    var merged = { style: rec.style, color: rec.color, materialType: rec.materialType, uom: rec.uom,
      widthIn: rec.widthIn, quantityIn: rec.quantityIn, quantity: rec.quantity, notes: rec.notes };
    ['style', 'color', 'materialType', 'uom', 'widthIn', 'quantityIn', 'quantity', 'notes'].forEach(function (k) {
      if (patch && k in patch) merged[k] = patch[k];
    });
    var err = validateOrderItem(merged);
    if (err) throw RepoError('INVALID_INPUT', err);
    var rowPatch = {
      style: String(merged.style).trim(), color: String(merged.color || '').trim() || null,
      material_type: merged.materialType, uom: merged.uom,
      width_in: merged.widthIn != null && merged.widthIn !== '' ? Math.round(Number(merged.widthIn)) : null,
      quantity_in: merged.uom === 'LF' ? Math.round(Number(merged.quantityIn)) : null,
      quantity: merged.uom === 'LF' ? null : Number(merged.quantity),
      notes: String(merged.notes || '').trim() || null
    };
    return self._patch('order_items', 'id=eq.' + encodeURIComponent(itemId), rowPatch).then(function () {
      rec.style = rowPatch.style; rec.color = String(merged.color || '').trim();
      rec.materialType = merged.materialType; rec.uom = merged.uom;
      rec.widthIn = rowPatch.width_in; rec.quantityIn = rowPatch.quantity_in; rec.quantity = rowPatch.quantity;
      rec.notes = String(merged.notes || '').trim();
      o.updatedAt = isoNow(); DB.save();
      logOrderEvent('ORDER_ITEM_UPDATED', { orderId: o.id, orderNumber: o.number, detail: 'Line ' + rec.seq });
      return { ok: true, order: o, item: rec };
    });
  },
  removeOrderItem: function (id, itemId) {
    var self = this;
    self._requireOnline('OFFLINE — ORDER ITEM NOT REMOVED');
    self._requireOrderPolicy(orderPolicy().canCreateOrder, 'Manager role required.');
    var o = orderById(id);
    if (!o) throw RepoError('NOT_FOUND', 'Order not found.');
    if (!orderEditable(o)) throw RepoError('INVALID_INPUT', 'Order is not editable.');
    var rec = orderItemById(o, itemId);
    if (!rec) throw RepoError('NOT_FOUND', 'Item not found.');
    return pgFetch('/rest/v1/order_items?id=eq.' + encodeURIComponent(itemId), { method: 'DELETE' })
      .then(function () {
        o.items = (o.items || []).filter(function (i) { return i.id !== itemId; });
        o.items.forEach(function (i, n) { i.seq = n + 1; });
        o.updatedAt = isoNow(); DB.save();
        logOrderEvent('ORDER_ITEM_REMOVED', { orderId: o.id, orderNumber: o.number, detail: rec.style });
        return { ok: true, order: o };
      });
  },
  markOrderReady: function (id) {
    var self = this;
    self._requireOnline('OFFLINE — ORDER NOT MARKED READY');
    self._requireOrderPolicy(orderPolicy().canMarkReady, 'Manager role required.');
    var o = orderById(id);
    if (!o) throw RepoError('NOT_FOUND', 'Order not found.');
    if (o.status !== 'DRAFT') throw RepoError('INVALID_INPUT', 'Order is not a draft.');
    if (!(o.items || []).length) throw RepoError('INVALID_INPUT', 'Add at least one item.');
    return self._patch('orders', 'id=eq.' + encodeURIComponent(id),
        { status: 'READY_FOR_REVIEW', updated_at: isoNow() })
      .then(function () {
        o.status = 'READY_FOR_REVIEW'; o.updatedAt = isoNow(); DB.save();
        logOrderEvent('ORDER_MARKED_READY', { orderId: o.id, orderNumber: o.number });
        return { ok: true, order: o };
      });
  },
  /* Atomic submit via the submit_sales_order RPC. Idempotent: a retried
     submit on an already-submitted order returns the existing sales order. */
  submitOrder: function (id) {
    var self = this;
    self._requireOnline('OFFLINE — ORDER NOT SUBMITTED');
    self._requireOrderPolicy(orderPolicy().canSubmitOrder, 'Manager role required.');
    var o = orderById(id);
    if (!o) throw RepoError('NOT_FOUND', 'Order not found.');
    if (o.status === 'SUBMITTED' && o.salesOrderId) {
      return self._refreshOrders().then(function () {
        var existing = salesOrderById(o.salesOrderId);
        if (existing) return { ok: true, salesOrder: existing, order: o, duplicate: true };
        throw RepoError('NOT_FOUND', 'Sales order missing.');
      });
    }
    if (!orderEditable(o)) throw RepoError('INVALID_INPUT', 'Order is not submittable.');
    if (!(o.items || []).length) throw RepoError('INVALID_INPUT', 'Add at least one item.');
    var soId = rid('SO'), by = DB.data.currentEmployee;
    /* Run 7: p_number null — the RPC issues the SO number server-side. */
    return self._rpc('submit_sales_order', {
        p_order_id: id, p_sales_order_id: soId, p_number: null, p_submitted_by: by
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshOrders().then(function () {
          var so = salesOrderById(res.sales_order_id);
          var oo = orderById(id);
          logOrderEvent('ORDER_SUBMITTED', { orderId: id, orderNumber: oo && oo.number,
            salesOrderId: res.sales_order_id, salesOrderNumber: res.number });
          return { ok: true, salesOrder: so, order: oo, duplicate: !!res.duplicate };
        });
      });
  },
  getSalesOrders: function () {
    var self = this;
    return self._refreshOrders().then(function () { return getSalesOrdersLocal(); });
  },
  getSalesOrder: function (id) {
    var self = this;
    return self._refreshOrders().then(function () { return salesOrderById(id); });
  },
  /* Idempotent release: a retried release on a released line returns the
     existing work order — never a duplicate. */
  releaseSalesOrderLine: function (soId, lineId) {
    var self = this;
    self._requireOnline('OFFLINE — SALES ORDER NOT RELEASED');
    self._requireOrderPolicy(orderPolicy().canReleaseLine, 'Supervisor role required.');
    var so = salesOrderById(soId);
    if (!so) throw RepoError('NOT_FOUND', 'Sales order not found.');
    if (so.onHold) throw RepoError('INVALID_INPUT', 'Sales order is on hold.');
    if (so.status === 'CANCELLED') throw RepoError('INVALID_INPUT', 'Sales order is cancelled.');
    var line = soLineById(so, lineId);
    if (!line) throw RepoError('NOT_FOUND', 'Line not found.');
    if (line.status === 'RELEASED' && line.workOrderId) {
      return self.getWorkOrder(line.workOrderId).then(function (wo) {
        return { ok: true, workOrder: wo, salesOrder: so, duplicate: true };
      });
    }
    var wo = buildWorkOrderFromLine(so, line);
    var wl = wo.lines[0];
    /* Run 7: p_wo_number null — the RPC issues the WO number server-side. */
    return self._rpc('release_sales_order_line', {
        p_line_id: lineId, p_work_order_id: wo.id, p_wo_number: null,
        p_style: wl.style, p_color: wl.color, p_material_type: wl.materialType,
        p_uom: wl.uom, p_width_in: wl.widthIn,
        p_required_in: wl.requiredIn, p_required_count: wl.requiredCount,
        p_by: DB.data.currentEmployee
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshOrders().then(function () {
          return self.getWorkOrder(res.work_order_id);
        }).then(function (freshWo) {
          var fso = salesOrderById(soId);
          logOrderEvent('SALES_ORDER_LINE_RELEASED', { salesOrderId: soId,
            salesOrderNumber: fso && fso.number, workOrderId: res.work_order_id,
            detail: 'Line ' + line.seq + ' released to warehouse.' });
          logOrderEvent('WORK_ORDER_GENERATED', { salesOrderId: soId,
            salesOrderNumber: fso && fso.number, workOrderId: res.work_order_id,
            detail: (freshWo && freshWo.number) + ' generated from line ' + line.seq + '.' });
          return { ok: true, workOrder: freshWo, salesOrder: fso, duplicate: !!res.duplicate };
        });
      });
  },
  /* ---- Run 7: central numbering + loadout + receipts ----
     Every mutation fails fast offline (never queued, never a misleading
     error) and enforces the centralized role policy before touching the
     backend. Numbers are backend-issued; the browser never invents one. */
  _refreshRun7: function () {
    var self = this;
    return self.hydrate().catch(function (err) {
      /* Offline reads fall back to cached data; any other failure (NETWORK,
         auth, RLS) must surface instead of silently returning stale data. */
      if (err && err.code === 'OFFLINE') return null;
      throw err;
    }).then(function () { return true; });
  },
  issueBusinessNumber: function (kind, requestKey) {
    /* Run 7: direct counter access is revoked in the backend — every document
       number is issued atomically inside its creating RPC (create_order,
       submit_sales_order, release_sales_order_line, start_loadout,
       create_receipt). This guard keeps any future caller from hitting a
       raw permission error. */
    var self = this;
    self._requireOnline('OFFLINE — NUMBER NOT ISSUED');
    return Promise.reject(RepoError('FORBIDDEN',
      'Document numbers are issued by the backend inside their creating RPC.'));
  },
  getLoadouts: function () {
    var self = this;
    return self._refreshRun7().then(function () { return getLoadoutsLocal(); });
  },
  getLoadout: function (id) {
    var self = this;
    return self._refreshRun7().then(function () { return loadoutById(id); });
  },
  startLoadout: function (woId, opts) {
    var self = this;
    self._requireOnline('OFFLINE — LOADOUT NOT STARTED');
    self._requireOrderPolicy(orderPolicy().canStartLoadout, 'Not authorized to start a loadout.');
    /* Refresh first so the local readiness pre-check reflects current data;
       the RPC re-checks readiness authoritatively server-side. */
    return self._refreshRun7().then(function () {
    opts = opts || {};
    var w = woById(woId);
    if (!w) throw RepoError('NOT_FOUND', 'Work order not found.');
    var rd = loadoutReadiness(w);
    if (!rd.ready && !rd.openLoadout)
      throw RepoError('INVALID_INPUT', 'Loadout is not ready: ' +
        rd.parts.filter(function (x) { return !x.r.ready; })
          .map(function (x) { return x.r.reason; }).join('; '));
    var loId = (rd.openLoadout && rd.openLoadout.id) || rid('LOAD');
    var reqKey = opts.clientRequestId || ('startloadout-' + loId);
    var lines = (w.lines || []).map(function (l) {
      var part = rd.parts.filter(function (x) { return x.line.id === l.id; })[0];
      var roll = part && part.r.roll;
      return { style: l.style, color: l.color, material_type: l.materialType, uom: l.uom,
        width_in: l.widthIn, required_in: l.requiredIn, required_count: l.requiredCount,
        prepared_in: part ? part.r.preparedIn : null,
        roll_id: roll ? roll.id : null,
        barcode: roll ? (roll.barcode || roll.id) : null };
    });
    return self._rpc('start_loadout', {
        p_loadout_id: loId, p_request_key: reqKey, p_work_order_id: woId,
        p_by: DB.data.currentEmployee, p_lines: lines
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshRun7().then(function () {
          var lo = loadoutById(res.loadout_id);
          logOrderEvent('LOADOUT_STARTED', { loadoutId: res.loadout_id,
            loadoutNumber: lo && lo.number, workOrderId: woId,
            salesOrderId: lo && lo.salesOrderId,
            detail: 'Loadout ' + (lo && lo.number) + ' started by ' + DB.data.currentEmployee + '.' });
          return { ok: true, loadout: lo, duplicate: !!res.duplicate };
        });
      });
    });
  },
  beginLoading: function (loId) {
    var self = this;
    self._requireOnline('OFFLINE — LOADING NOT STARTED');
    self._requireOrderPolicy(orderPolicy().canLoadMaterial, 'Not authorized to load material.');
    return self._rpc('begin_loadout_loading', { p_loadout_id: loId, p_by: DB.data.currentEmployee })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshRun7().then(function () {
          var lo = loadoutById(loId);
          if (!res.duplicate)
            logOrderEvent('LOADOUT_LOADING_BEGUN', { loadoutId: loId,
              loadoutNumber: lo && lo.number, workOrderId: lo && lo.workOrderId,
              salesOrderId: lo && lo.salesOrderId, detail: 'Employee is actively loading.' });
          return { ok: true, loadout: lo, duplicate: !!res.duplicate };
        });
      });
  },
  verifyLoadoutLine: function (loId, lineId, code) {
    var self = this;
    self._requireOnline('OFFLINE — LINE NOT VERIFIED');
    self._requireOrderPolicy(orderPolicy().canVerifyLoadout, 'Not authorized to verify material.');
    return self._rpc('verify_loadout_line', {
        p_loadout_id: loId, p_line_id: lineId,
        p_barcode: normalizeBarcode(String(code || '')), p_by: DB.data.currentEmployee
      })
      .then(self._rpcResult)
      .then(function (res) {
        if (res.wrong_material)
          return self._refreshRun7().then(function () {
            var lo = loadoutById(loId);
            var line = lo && loadoutLineById(lo, lineId);
            logOrderEvent('LOADOUT_EXCEPTION', { loadoutId: loId,
              loadoutNumber: lo && lo.number, workOrderId: lo && lo.workOrderId,
              salesOrderId: lo && lo.salesOrderId,
              detail: 'Line ' + (line && line.seq) + ': WRONG MATERIAL — scanned ' +
                normalizeBarcode(String(code || '')) + ', expected ' + (line && line.barcode || '—') + '.' });
            throw RepoError('WRONG MATERIAL', 'Wrong material scanned — flagged as an exception.');
          });
        return self._refreshRun7().then(function () {
          var lo = loadoutById(loId);
          var line = lo && loadoutLineById(lo, lineId);
          if (!res.duplicate)
            logOrderEvent('MATERIAL_VERIFIED', { loadoutId: loId,
              loadoutNumber: lo && lo.number, workOrderId: lo && lo.workOrderId,
              salesOrderId: lo && lo.salesOrderId,
              detail: 'Line ' + (line && line.seq) + ': roll ' + (line && line.barcode) + ' verified.' });
          return { ok: true, line: line, duplicate: !!res.duplicate };
        });
      });
  },
  markLoadoutLineLoaded: function (loId, lineId) {
    var self = this;
    self._requireOnline('OFFLINE — LINE NOT MARKED LOADED');
    self._requireOrderPolicy(orderPolicy().canLoadMaterial, 'Not authorized to load material.');
    return self._rpc('mark_loadout_line_loaded', {
        p_loadout_id: loId, p_line_id: lineId, p_by: DB.data.currentEmployee
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshRun7().then(function () {
          var lo = loadoutById(loId);
          var line = lo && loadoutLineById(lo, lineId);
          if (!res.duplicate)
            logOrderEvent('MATERIAL_LOADED', { loadoutId: loId,
              loadoutNumber: lo && lo.number, workOrderId: lo && lo.workOrderId,
              salesOrderId: lo && lo.salesOrderId,
              detail: 'Line ' + (line && line.seq) + ' loaded by ' + DB.data.currentEmployee + '.' });
          return { ok: true, line: line, duplicate: !!res.duplicate };
        });
      });
  },
  createLoadoutException: function (loId, lineId, type, notes) {
    var self = this;
    self._requireOnline('OFFLINE — EXCEPTION NOT FLAGGED');
    self._requireOrderPolicy(orderPolicy().canLoadMaterial, 'Not authorized.');
    return self._rpc('create_loadout_exception', {
        p_loadout_id: loId, p_line_id: lineId || '', p_type: type,
        p_notes: String(notes || ''), p_by: DB.data.currentEmployee
      })
      .then(self._rpcResult)
      .then(function () {
        return self._refreshRun7().then(function () {
          var lo = loadoutById(loId);
          logOrderEvent('LOADOUT_EXCEPTION', { loadoutId: loId,
            loadoutNumber: lo && lo.number, workOrderId: lo && lo.workOrderId,
            salesOrderId: lo && lo.salesOrderId,
            detail: type + (notes ? ' — ' + notes : '') + ' flagged by ' + DB.data.currentEmployee + '.' });
          return { ok: true, loadout: lo };
        });
      });
  },
  completeLoadout: function (loId) {
    var self = this;
    self._requireOnline('OFFLINE — LOADOUT NOT COMPLETED');
    self._requireOrderPolicy(orderPolicy().canCompleteLoadout, 'Not authorized to complete a loadout.');
    return self._rpc('complete_loadout', { p_loadout_id: loId, p_by: DB.data.currentEmployee })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshRun7().then(function () {
          var lo = loadoutById(loId);
          if (!res.duplicate)
            logOrderEvent('LOADOUT_COMPLETED', { loadoutId: loId,
              loadoutNumber: lo && lo.number, workOrderId: lo && lo.workOrderId,
              salesOrderId: lo && lo.salesOrderId,
              detail: 'Loadout ' + (lo && lo.number) + ' completed.' });
          return { ok: true, loadout: lo, duplicate: !!res.duplicate };
        });
      });
  },
  getReceipts: function () {
    var self = this;
    return self._refreshRun7().then(function () { return getReceiptsLocal(); });
  },
  getReceipt: function (id) {
    var self = this;
    return self._refreshRun7().then(function () { return receiptById(id); });
  },
  createReceipt: function (o) {
    var self = this;
    self._requireOnline('OFFLINE — RECEIPT NOT CREATED');
    self._requireOrderPolicy(orderPolicy().canReceiveMaterial, 'Not authorized to receive material.');
    o = o || {};
    var rcId = rid('RCV');
    var reqKey = o.clientRequestId || ('createreceipt-' + rcId);
    return self._rpc('create_receipt', {
        p_receipt_id: rcId, p_request_key: reqKey,
        p_supplier: String(o.supplier || ''), p_reference: String(o.referenceNumber || ''),
        p_expected: !!o.expected, p_notes: String(o.notes || ''),
        p_by: DB.data.currentEmployee
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshRun7().then(function () {
          return { ok: true, receipt: receiptById(res.receipt_id), duplicate: !!res.duplicate };
        });
      });
  },
  addReceiptLine: function (rcId, line) {
    var self = this;
    self._requireOnline('OFFLINE — RECEIPT LINE NOT ADDED');
    self._requireOrderPolicy(orderPolicy().canReceiveMaterial, 'Not authorized to receive material.');
    line = line || {};
    var reqKey = line.clientRequestId || rid('CRQ');
    return self._rpc('add_receipt_line', {
        p_receipt_id: rcId, p_line_id: rid('RL'), p_request_key: reqKey,
        p_material_type: line.materialType || null, p_uom: line.uom || null,
        p_style: String(line.style || ''), p_color: String(line.color || ''),
        p_expected_qty_in: line.expectedQtyIn || null,
        p_expected_qty: line.expectedQty || null,
        p_notes: String(line.notes || '')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshRun7().then(function () {
          return { ok: true, receipt: receiptById(rcId), duplicate: !!res.duplicate };
        });
      });
  },
  receiveRoll: function (rcId, o) {
    var self = this;
    self._requireOnline('OFFLINE — ROLL NOT RECEIVED');
    self._requireOrderPolicy(orderPolicy().canReceiveMaterial, 'Not authorized to receive material.');
    o = o || {};
    var reqKey = o.clientRequestId || rid('CRQ');
    var barcode = normalizeBarcode(String(o.barcode || ''));
    if (!barcode) throw RepoError('INVALID_INPUT', 'ROLL BARCODE REQUIRED');
    if (!(Math.round(Number(o.lengthIn)) > 0)) throw RepoError('INVALID_INPUT', 'RECEIVED LENGTH REQUIRED');
    if (!o.style && !o.supervisorOverride) throw RepoError('INVALID_INPUT', 'STYLE REQUIRED');
    if (o.supervisorOverride)
      self._requireOrderPolicy(orderPolicy().canReviewExceptions, 'Supervisor role required.');
    return self._rpc('receive_roll', {
        p_receipt_id: rcId, p_line_id: rid('RL'), p_request_key: reqKey,
        p_barcode: barcode, p_roll_id: barcode,
        p_style: String(o.style || ''), p_color: String(o.color || ''),
        p_manufacturer: String(o.manufacturer || ''),
        p_width_in: o.widthIn != null ? Number(o.widthIn) : null,
        p_length_in: Math.round(Number(o.lengthIn)),
        p_location_code: String(o.location || '').trim() || null,
        p_by: DB.data.currentEmployee, p_override: !!o.supervisorOverride
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshRun7().then(function () {
          if (res.duplicate_roll)
            return { ok: true, receipt: receiptById(rcId),
              roll: rollById(res.roll_id), duplicateRoll: true };
          return { ok: true, receipt: receiptById(rcId),
            line: null, roll: rollById(res.roll_id), duplicate: !!res.duplicate };
        });
      });
  },
  createReceiptException: function (rcId, type, notes) {
    var self = this;
    self._requireOnline('OFFLINE — EXCEPTION NOT FLAGGED');
    self._requireOrderPolicy(orderPolicy().canReceiveMaterial, 'Not authorized.');
    return self._rpc('create_receipt_exception', {
        p_receipt_id: rcId, p_line_id: '', p_type: type,
        p_notes: String(notes || ''), p_by: DB.data.currentEmployee
      })
      .then(self._rpcResult)
      .then(function () {
        return self._refreshRun7().then(function () {
          return { ok: true, receipt: receiptById(rcId) };
        });
      });
  },
  completeReceipt: function (rcId) {
    var self = this;
    self._requireOnline('OFFLINE — RECEIPT NOT COMPLETED');
    self._requireOrderPolicy(orderPolicy().canCompleteReceipt, 'Not authorized to complete a receipt.');
    return self._rpc('complete_receipt', { p_receipt_id: rcId, p_by: DB.data.currentEmployee })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshRun7().then(function () {
          return { ok: true, receipt: receiptById(rcId), duplicate: !!res.duplicate };
        });
      });
  },

  /* ================= Run 8: Returns + Returned Material Disposition (shared) ==
     All balance changes go through the atomic RPCs (return_restock,
     create_returned_remnant, …) — never direct table writes. The UI never
     calls Supabase directly; these methods are the only shared path. */
  _refreshReturns: function () {
    var self = this;
    return self.hydrate().catch(function (err) {
      if (err && err.code === 'OFFLINE') return null;
      throw err;
    }).then(function () { return true; });
  },
  getReturns: function () {
    var self = this;
    return self._refreshReturns().then(function () { return (FG().returns || []).slice(); });
  },
  getReturn: function (id) {
    var self = this;
    return self._refreshReturns().then(function () { return returnById(id); });
  },
  getReturnItems: function (returnId) {
    var self = this;
    return self._refreshReturns().then(function () { return returnItemsFor(returnId); });
  },
  getReturnItem: function (id) {
    var self = this;
    return self._refreshReturns().then(function () { return returnItemById(id); });
  },
  getReturnDispositions: function (itemId) {
    var self = this;
    return self._refreshReturns().then(function () { return returnDispositionsFor(itemId); });
  },
  getReturnedRemnants: function (returnId) {
    var self = this;
    return self._refreshReturns().then(function () { return remnantsForReturn(returnId); });
  },
  getAvailableRemnants: function () {
    var self = this;
    return self._refreshReturns().then(function () { return availableRemnants(); });
  },
  getReturnExceptions: function (returnId) {
    var self = this;
    return self._refreshReturns().then(function () { return returnExceptionsFor(returnId); });
  },
  getRemnantById: function (id) {
    var self = this;
    return self._refreshReturns().then(function () { return remnantById(id); });
  },
  createReturn: function (o) {
    var self = this;
    self._requireOnline('OFFLINE — RETURN NOT CREATED');
    self._requireOrderPolicy(returnPolicy().canCreateReturn, 'Not authorized to create returns.');
    o = o || {};
    var id = o.id || rid('RT');
    var reqKey = o.requestKey || rid('K');
    return self._rpc('create_return', {
        p_id: id, p_warehouse_id: self.wh(),
        p_work_order_id: o.workOrderId || null, p_sales_order_id: o.salesOrderId || null,
        p_loadout_id: o.loadoutId || null, p_property: o.property || null,
        p_account: o.account || null, p_source_kind: o.sourceKind || 'MANUAL',
        p_reason: o.reason || 'OTHER', p_notes: o.notes || null,
        p_employee: DB.data.currentEmployee, p_request_key: reqKey
      })
      .then(self._rpcResult)
      .then(function (res) {
        /* On a duplicate retry the server returns the ORIGINAL id — use it,
           not the freshly generated local id. */
        var rid2 = (res && res.return_id) || id;
        return self._refreshReturns().then(function () {
          return { ok: true, return: returnById(rid2), duplicate: !!res.duplicate };
        });
      });
  },
  receiveReturn: function (id) {
    var self = this;
    /* Accept id string or { id } object (UI passes { id }). */
    var rid = (id && typeof id === 'object') ? id.id : id;
    self._requireOnline('OFFLINE — RETURN NOT RECEIVED');
    self._requireOrderPolicy(returnPolicy().canReceiveReturn, 'Not authorized to receive returns.');
    return self._rpc('receive_return', {
        p_return_id: rid, p_employee: DB.data.currentEmployee, p_request_key: rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, return: returnById(rid), duplicate: !!res.duplicate };
        });
      });
  },
  submitReturn: function (id) {
    var self = this;
    self._requireOnline('OFFLINE — RETURN NOT SUBMITTED');
    self._requireOrderPolicy(returnPolicy().canCreateReturn, 'Not authorized to submit returns.');
    return self._rpc('submit_return', {
        p_return_id: id, p_employee: DB.data.currentEmployee, p_request_key: rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, return: returnById(id), duplicate: !!res.duplicate };
        });
      });
  },
  addReturnItem: function (returnId, it) {
    var self = this;
    self._requireOnline('OFFLINE — RETURN ITEM NOT ADDED');
    self._requireOrderPolicy(returnPolicy().canCreateReturn, 'Not authorized to create returns.');
    it = it || {};
    var id = it.id || rid('RI');
    var reqKey = it.requestKey || rid('K');
    return self._rpc('add_return_item', {
        p_id: id, p_return_id: returnId, p_warehouse_id: self.wh(),
        p_material_type: it.materialType || 'CARPET', p_product_id: it.productId || null,
        p_roll_id: it.rollId || null,
        p_source_inventory_assignment_id: it.sourceAssignmentId || null,
        p_source_loadout_line_id: it.sourceLoadoutLineId || null,
        p_style: it.style || null, p_color: it.color || null,
        p_width_in: it.widthIn != null ? it.widthIn : null, p_uom: it.uom || 'IN',
        p_returned_quantity: it.returnedQuantity != null ? it.returnedQuantity : null,
        p_location_code: it.locationCode || null, p_notes: it.notes || null,
        p_employee: DB.data.currentEmployee, p_request_key: reqKey
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, item: returnItemById(id), duplicate: !!res.duplicate };
        });
      });
  },
  measureReturnItem: function (itemId, inches) {
    var self = this;
    self._requireOnline('OFFLINE — RETURN NOT MEASURED');
    self._requireOrderPolicy(returnPolicy().canMeasureReturn, 'Not authorized to measure returns.');
    return self._rpc('measure_return_item', {
        p_item_id: itemId, p_measured_in: inches,
        p_employee: DB.data.currentEmployee, p_request_key: rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, item: returnItemById(itemId), duplicate: !!res.duplicate };
        });
      });
  },
  inspectReturnItem: function (itemId, condition, notes) {
    var self = this;
    self._requireOnline('OFFLINE — RETURN NOT INSPECTED');
    self._requireOrderPolicy(returnPolicy().canInspectReturn, 'Not authorized to inspect returns.');
    return self._rpc('inspect_return_item', {
        p_item_id: itemId, p_condition: condition,
        p_employee: DB.data.currentEmployee, p_notes: notes || null, p_request_key: rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, item: returnItemById(itemId), duplicate: !!res.duplicate };
        });
      });
  },
  approveRestock: function (itemId, o) {
    /* THE atomic balance change. Optimistic version guard: on a stale
       version the RPC raises ROLL_VERSION_CONFLICT and nothing is written. */
    var self = this;
    self._requireOnline('OFFLINE — RESTOCK NOT SYNCED');
    self._requireOrderPolicy(returnPolicy().canApproveRestock, 'Restock approval requires a supervisor or above.');
    o = o || {};
    return self._rpc('return_restock', {
        p_item_id: itemId, p_roll_id: o.rollId, p_roll_version: o.rollVersion,
        p_location_code: o.locationCode || null, p_employee: DB.data.currentEmployee,
        p_approver: o.approver || DB.data.currentEmployee, p_request_key: o.requestKey || rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, duplicate: !!res.duplicate,
            previousBalanceIn: res.previous_balance_in, quantityIn: res.quantity_in,
            newBalanceIn: res.new_balance_in, newVersion: res.new_version };
        });
      });
  },
  createReturnedRemnant: function (itemId, o) {
    var self = this;
    self._requireOnline('OFFLINE — REMNANT NOT CREATED');
    self._requireOrderPolicy(returnPolicy().canCreateRemnant, 'Remnant creation requires a supervisor or above.');
    o = o || {};
    return self._rpc('create_returned_remnant', {
        p_item_id: itemId, p_length_in: o.lengthIn,
        p_location_code: o.locationCode || null, p_employee: DB.data.currentEmployee,
        p_request_key: o.requestKey || rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, duplicate: !!res.duplicate, remnant: remnantById(res.remnant_id) };
        });
      });
  },
  quarantineReturnItem: function (itemId, o) {
    var self = this;
    self._requireOnline('OFFLINE — RETURN NOT QUARANTINED');
    self._requireOrderPolicy(returnPolicy().canQuarantine, 'Quarantine requires a supervisor or above.');
    o = o || {};
    return self._rpc('quarantine_return_item', {
        p_item_id: itemId, p_reason: o.reason || '',
        p_location_code: o.locationCode || null, p_employee: DB.data.currentEmployee,
        p_request_key: o.requestKey || rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, duplicate: !!res.duplicate };
        });
      });
  },
  scrapReturnItem: function (itemId, o) {
    var self = this;
    self._requireOnline('OFFLINE — RETURN NOT SCRAPPED');
    self._requireOrderPolicy(returnPolicy().canScrap, 'Scrap authorization requires a manager or admin.');
    o = o || {};
    return self._rpc('scrap_return_item', {
        p_item_id: itemId, p_reason: o.reason || '',
        p_employee: DB.data.currentEmployee, p_request_key: o.requestKey || rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, duplicate: !!res.duplicate };
        });
      });
  },
  sendReturnToVendor: function (itemId, o) {
    var self = this;
    self._requireOnline('OFFLINE — VENDOR RETURN NOT RECORDED');
    self._requireOrderPolicy(returnPolicy().canVendorReturn, 'Vendor returns require a manager or admin.');
    o = o || {};
    return self._rpc('send_return_to_vendor', {
        p_item_id: itemId, p_supplier: o.supplier || '', p_reference: o.reference || null,
        p_employee: DB.data.currentEmployee, p_request_key: o.requestKey || rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, duplicate: !!res.duplicate, vendorStatus: res.vendor_status };
        });
      });
  },
  holdReturnItem: function (itemId, reason) {
    var self = this;
    self._requireOnline('OFFLINE — HOLD NOT RECORDED');
    self._requireOrderPolicy(returnPolicy().canQuarantine, 'Hold for review requires a supervisor or above.');
    return self._rpc('hold_return_item', {
        p_item_id: itemId, p_reason: reason || null,
        p_employee: DB.data.currentEmployee, p_request_key: rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, duplicate: !!res.duplicate };
        });
      });
  },
  completeReturn: function (id) {
    var self = this;
    self._requireOnline('OFFLINE — RETURN NOT COMPLETED');
    self._requireOrderPolicy(returnPolicy().canApproveRestock, 'Completing a return requires a supervisor or above.');
    return self._rpc('complete_return', {
        p_return_id: id, p_employee: DB.data.currentEmployee, p_request_key: rid('K')
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, return: returnById(id), duplicate: !!res.duplicate };
        });
      });
  },
  cancelReturn: function (id, reason) {
    var self = this;
    self._requireOnline('OFFLINE — RETURN NOT CANCELLED');
    self._requireOrderPolicy(returnPolicy().canCancelReturn, 'Cancelling a return requires a manager or admin.');
    return self._rpc('cancel_return', {
        p_return_id: id, p_reason: reason || null, p_employee: DB.data.currentEmployee
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, return: returnById(id), duplicate: !!res.duplicate };
        });
      });
  },
  raiseReturnException: function (returnId, o) {
    var self = this;
    self._requireOnline('OFFLINE — EXCEPTION NOT RAISED');
    self._requireOrderPolicy(returnPolicy().canCreateReturn, 'Not authorized to raise return exceptions.');
    o = o || {};
    return self._rpc('raise_return_exception', {
        p_return_id: returnId, p_kind: o.kind || 'OTHER', p_detail: o.detail || null,
        p_item_id: o.itemId || null, p_employee: DB.data.currentEmployee
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () {
          return { ok: true, exception: (returnExceptionsFor(returnId) || [])
            .filter(function (e) { return e.id === res.exception_id; })[0] || null };
        });
      });
  },
  resolveReturnException: function (exceptionId, resolution) {
    var self = this;
    self._requireOnline('OFFLINE — EXCEPTION NOT RESOLVED');
    self._requireOrderPolicy(returnPolicy().canResolveReturnExceptions, 'Resolving exceptions requires a supervisor or above.');
    return self._rpc('resolve_return_exception', {
        p_exception_id: exceptionId, p_resolution: resolution || null,
        p_employee: DB.data.currentEmployee
      })
      .then(self._rpcResult)
      .then(function (res) {
        return self._refreshReturns().then(function () { return { ok: true, duplicate: !!res.duplicate }; });
      });
  },
  uploadReturnDocument: function (o) {
    /* o: {returnId, docType, imageDataUrl, mimeType, employee} — backend-authoritative:
       image bytes go to private storage, the metadata row links return_id. */
    var self = this;
    self._requireOnline('OFFLINE — DOCUMENT NOT SAVED');
    self._requireOrderPolicy(returnPolicy().canReceiveReturn, 'Not authorized to handle returns.');
    var bytes = dataUrlToBytes(o.imageDataUrl);
    if (!bytes) return Promise.reject(RepoError('INVALID_INPUT', 'No image data.'));
    if (!o.returnId) return Promise.reject(RepoError('INVALID_INPUT', 'RETURN REQUIRED'));
    var wh = self.wh();
    var path = wh + '/returns/' + o.returnId + '/' + rid('RD') + '.jpg';
    return pgFetch('/storage/v1/object/history-cards/' + path, {
      method: 'POST', body: bytes, contentType: o.mimeType || 'image/jpeg'
    }).then(function () {
      var row = {
        id: rid('D'), roll_id: null, receipt_id: null, return_id: o.returnId,
        warehouse_id: wh, storage_path: path,
        document_type: o.docType || 'RETURN_CONDITION',
        employee_name: o.employee || DB.data.currentEmployee || null,
        captured_at: isoNow(), mime_type: o.mimeType || 'image/jpeg',
        byte_size: bytes.length
      };
      return self._post('documents', [row]).then(function () {
        return { row: row, path: path };
      });
    }).then(function (up) {
      return self._refreshReturns().then(function () { return up; });
    }).then(function (up) {
      var doc = Mappers.rowToDocument({
        id: up.row.id, roll_id: null, receipt_id: null, return_id: o.returnId,
        document_type: o.docType || 'RETURN_CONDITION', employee_name: o.employee || null,
        captured_at: isoNow(), storage_path: up.path });
      doc.image = o.imageDataUrl || null;
      logOrderEvent('DOCUMENT_CAPTURED', { returnId: o.returnId, detail: doc.docType + ' captured.' });
      return { ok: true, doc: doc };
    });
  },
  getDocumentsForReturn: function (returnId) {
    var self = this;
    return self._refreshReturns().then(function () { return returnDocuments(returnId); });
  },
  /* ================= end Run 8 (shared) ============ */

  holdSalesOrder: function (soId, reason) {
    var self = this;
    self._requireOnline('OFFLINE — SALES ORDER NOT HELD');
    self._requireOrderPolicy(orderPolicy().canHoldSalesOrder, 'Manager role required.');
    reason = String(reason || '').trim();
    if (!reason) throw RepoError('INVALID_INPUT', 'Reason is required.');
    var so = salesOrderById(soId);
    if (!so) throw RepoError('NOT_FOUND', 'Sales order not found.');
    if (so.onHold) throw RepoError('INVALID_INPUT', 'Already on hold.');
    if (so.status === 'CANCELLED') throw RepoError('INVALID_INPUT', 'Sales order is cancelled.');
    var at = isoNow(), by = DB.data.currentEmployee;
    return self._patch('sales_orders', 'id=eq.' + encodeURIComponent(soId),
        { on_hold: true, hold_reason: reason, hold_at: at, hold_by: by, status: 'ON_HOLD', updated_at: at })
      .then(function () { return self._orderAudit('SALES_ORDER_HELD', { salesOrderId: soId }, { reason: reason }); })
      .then(function () {
        so.onHold = true; so.holdReason = reason; so.holdAt = at; so.holdBy = by;
        so.status = 'ON_HOLD'; so.updatedAt = at; DB.save();
        logOrderEvent('SALES_ORDER_HELD', { salesOrderId: so.id, salesOrderNumber: so.number, detail: reason });
        return { ok: true, salesOrder: so };
      });
  },
  resumeSalesOrder: function (soId) {
    var self = this;
    self._requireOnline('OFFLINE — SALES ORDER NOT RESUMED');
    self._requireOrderPolicy(orderPolicy().canHoldSalesOrder, 'Manager role required.');
    var so = salesOrderById(soId);
    if (!so) throw RepoError('NOT_FOUND', 'Sales order not found.');
    if (!so.onHold) throw RepoError('INVALID_INPUT', 'Not on hold.');
    var at = isoNow();
    return self._patch('sales_orders', 'id=eq.' + encodeURIComponent(soId),
        { on_hold: false, hold_reason: null, hold_at: null, hold_by: null, status: 'OPEN', updated_at: at })
      .then(function () { return self._orderAudit('SALES_ORDER_RESUMED', { salesOrderId: soId }, null); })
      .then(function () {
        so.onHold = false; so.holdReason = null; so.holdAt = null; so.holdBy = null;
        so.status = 'OPEN'; so.updatedAt = at; DB.save();
        logOrderEvent('SALES_ORDER_RESUMED', { salesOrderId: so.id, salesOrderNumber: so.number });
        return { ok: true, salesOrder: so };
      });
  },
  cancelSalesOrder: function (soId, reason, opts) {
    var self = this;
    self._requireOnline('OFFLINE — SALES ORDER NOT CANCELLED');
    self._requireOrderPolicy(orderPolicy().canCancelSalesOrder, 'Manager role required.');
    reason = String(reason || '').trim();
    if (!reason) throw RepoError('INVALID_INPUT', 'Reason is required.');
    var so = salesOrderById(soId);
    if (!so) throw RepoError('NOT_FOUND', 'Sales order not found.');
    if (so.status === 'CANCELLED') throw RepoError('INVALID_INPUT', 'Already cancelled.');
    var wos = (so.lines || []).map(function (l) { return l.workOrderId && woById(l.workOrderId); }).filter(Boolean);
    if (wos.length && !(opts && opts.force))
      throw RepoError('WAREHOUSE_WORK_EXISTS', 'Warehouse work already exists for this sales order.',
        { workOrders: wos.map(function (w) { return w.number; }) });
    var at = isoNow();
    return self._patch('sales_orders', 'id=eq.' + encodeURIComponent(soId),
        { status: 'CANCELLED', on_hold: false, updated_at: at })
      .then(function () { return self._orderAudit('SALES_ORDER_CANCELLED', { salesOrderId: soId }, { reason: reason }); })
      .then(function () {
        so.status = 'CANCELLED'; so.onHold = false; so.updatedAt = at; DB.save();
        logOrderEvent('SALES_ORDER_CANCELLED', { salesOrderId: so.id, salesOrderNumber: so.number, detail: reason });
        return { ok: true, salesOrder: so };
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
  assignRemnantInventory: function (o) {
    /* o: {workOrderId, lineId, remnantId, reservedIn, employee, warehouseId,
           location, mismatchApprovedBy, clientRequestId} */
    var self = this;
    return self._rpc('reserve_remnant', {
      p_work_order_id: o.workOrderId, p_line_id: o.lineId || null,
      p_remnant_id: o.remnantId, p_reserved_in: Math.round(o.reservedIn),
      p_employee_name: o.employee || null,
      p_warehouse_id: o.warehouseId || self.wh(),
      p_location_code: o.location || null,
      p_client_request_id: o.clientRequestId || rid('AR'),
      p_mismatch_approved_by: o.mismatchApprovedBy || null
    }).then(function (res) {
      var r = self._rpcResult(res);
      return { ok: true, duplicate: !!r.duplicate, assignmentId: r.assignment_id,
        remnantNumber: r.remnant_number };
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
  uploadReceiptDocument: function (o) {
    /* o: {receiptId, imageDataUrl, mimeType, employee} — backend-authoritative:
       image bytes go to private storage, the metadata row links receipt_id. */
    var self = this;
    self._requireOnline('OFFLINE — DOCUMENT NOT SAVED');
    self._requireOrderPolicy(orderPolicy().canReceiveMaterial, 'Not authorized to receive material.');
    var bytes = dataUrlToBytes(o.imageDataUrl);
    if (!bytes) return Promise.reject(RepoError('INVALID_INPUT', 'No image data.'));
    if (!o.receiptId) return Promise.reject(RepoError('INVALID_INPUT', 'RECEIPT REQUIRED'));
    var wh = self.wh();
    var path = wh + '/receipts/' + o.receiptId + '/' + rid('RD') + '.jpg';
    return pgFetch('/storage/v1/object/history-cards/' + path, {
      method: 'POST', body: bytes, contentType: o.mimeType || 'image/jpeg'
    }).then(function () {
      var row = {
        id: rid('D'), roll_id: null, receipt_id: o.receiptId, warehouse_id: wh,
        storage_path: path, document_type: 'RECEIVING DOCUMENT',
        employee_name: o.employee || DB.data.currentEmployee || null,
        captured_at: isoNow(), mime_type: o.mimeType || 'image/jpeg',
        byte_size: bytes.length
      };
      return self._post('documents', [row]).then(function () {
        return { row: row, path: path };
      });
    }).then(function (up) {
      return self._refreshRun7().then(function () { return up; });
    }).then(function (up) {
      var doc = Mappers.rowToDocument({
        id: up.row.id, roll_id: null, receipt_id: o.receiptId,
        document_type: 'RECEIVING DOCUMENT', employee_name: o.employee || null,
        captured_at: isoNow(), storage_path: up.path });
      doc.image = o.imageDataUrl || null;
      return { ok: true, doc: doc };
    });
  },
  getDocumentsForReceipt: function (receiptId) {
    var self = this;
    return self._get('documents', { receipt_id: 'eq.' + receiptId, select: '*' })
      .then(function (rows) { return rows.map(Mappers.rowToDocument); });
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
      get('discrepancies'), get('audit_events'),
      /* Run 6: commercial layer. order_items / sales_order_lines carry no
         warehouse_id — they are scoped to their parent order's warehouse. */
      get('orders'), self._get('order_items', { select: '*' }),
      get('sales_orders'), self._get('sales_order_lines', { select: '*' }),
      /* Run 7: loadout + receipts + central numbering. */
      get('loadouts'), self._get('loadout_lines', { select: '*' }),
      self._get('loadout_exceptions', { select: '*' }),
      get('receipts'), self._get('receipt_lines', { select: '*' }),
      self._get('receipt_exceptions', { select: '*' }),
      /* Run 8: returns + returned material disposition. */
      get('returns'), self._get('return_items', { select: '*' }),
      self._get('return_dispositions', { select: '*' }),
      get('returned_remnants'),
      self._get('return_exceptions', { select: '*' })
    ]).then(function (p) {
      var warehouses = p[0], users = p[1], rollRows = p[2], woRows = p[3],
          lineRows = p[4], asnRows = p[5], cutRows = p[6], sessRows = p[7],
          countRows = p[8], histRows = p[9], docRows = p[10], impRows = p[11],
          discRows = p[12], auditRows = p[13],
          orderRows = p[14], orderItemRows = p[15],
          soRows = p[16], soLineRows = p[17],
          loRows = p[18], loLineRows = p[19], loExRows = p[20],
          rcRows = p[21], rcLineRows = p[22], rcExRows = p[23],
          retRows = p[24], retItemRows = p[25], retDispRows = p[26],
          remRows = p[27], retExRows = p[28];
      var fg = FG();
      /* warehouses + employees */
      var roleMap = { WAREHOUSE_EMPLOYEE: 'WORKER', SUPERVISOR: 'SUPERVISOR', MANAGER: 'MANAGER', ADMIN: 'ADMIN' };
      if (warehouses.length) {
        DB.data.warehouses = warehouses.map(function (w) {
          return { id: w.id, name: w.name, timezone: w.timezone || 'America/New_York' };
        });
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
      /* Shared rows carry no stored num; derive the per-roll / per-receipt
         sequence (oldest first) so the doc screen, document lists, and
         exports never render "HISTORY CARD #undefined". */
      (function assignDocNums() {
        var groups = {};
        fg.documents.forEach(function (doc) {
          var key = doc.rollId ? 'roll:' + doc.rollId : (doc.receiptId ? 'rcpt:' + doc.receiptId : null);
          if (!key) return;
          (groups[key] = groups[key] || []).push(doc);
        });
        Object.keys(groups).forEach(function (key) {
          groups[key].sort(function (a, b) { return new Date(a.at) - new Date(b.at); })
            .forEach(function (doc, i) { doc.num = i + 1; });
        });
      })();
      fg.discrepancies = discRows.map(Mappers.rowToDiscrepancy);
      fg.auditEvents = auditRows;
      /* Run 6: commercial layer joins the local mirror. */
      fg.orders = (orderRows || []).map(function (r) { return Mappers.rowToOrder(r, orderItemRows); });
      fg.salesOrders = (soRows || []).map(function (r) { return Mappers.rowToSalesOrder(r, soLineRows); });
      /* Run 7: loadout + receipts join the local mirror. */
      fg.loadouts = (loRows || []).map(function (r) { return Mappers.rowToLoadout(r, loLineRows, loExRows); });
      fg.receipts = (rcRows || []).map(function (r) { return Mappers.rowToReceipt(r, rcLineRows, rcExRows); });
      /* Run 8: returns + returned material disposition join the local mirror. */
      fg.returns = (retRows || []).map(function (r) { return Mappers.rowToReturn(r, retItemRows, retExRows); });
      fg.returnItems = (retItemRows || []).map(Mappers.rowToReturnItem);
      fg.returnDispositions = (retDispRows || []).map(Mappers.rowToReturnDisposition);
      fg.returnedRemnants = (remRows || []).map(Mappers.rowToReturnedRemnant);
      fg.returnExceptions = (retExRows || []).map(Mappers.rowToReturnException);
      /* Run 8: return audit rows join the local return-activity feed so
         returns from other devices appear after a refresh.
         Idempotent: skip audit rows already reflected (by audit id). */
      (auditRows || []).filter(function (r) { return r.entity_type === 'return'; }).forEach(function (r) {
        var already = (FG().orderEvents || []).some(function (e) {
          return e.auditId === r.id;
        });
        if (already) return;
        var detail = '';
        var nv = r.new_value;
        if (typeof nv === 'string') { try { nv = JSON.parse(nv); } catch (e) { nv = null; } }
        if (nv && nv.detail) detail = nv.detail;
        logReturnEvent(r.action, { returnId: r.entity_id, detail: detail,
          user: r.user_name, auditId: r.id, at: r.created_at });
      });
      migrateFloorguardV6toV7(); /* ensure return collections exist on the mirror */
      /* Run 7: receipt audit rows join the local receipt-activity feed so
         receiving from other devices appears after a refresh. */
      fg.receiptEvents = (auditRows || []).filter(function (r) { return r.entity_type === 'receipt'; })
        .map(function (r) {
          var nv = r.new_value;
          if (typeof nv === 'string') { try { nv = JSON.parse(nv); } catch (e) { nv = null; } }
          return { id: 'AE-' + r.id, receiptId: r.entity_id, action: r.action,
            user: r.user_name || '', at: r.created_at,
            rollId: (nv && nv.roll_id) || null,
            detail: (nv && nv.barcode) ? ('Roll ' + nv.barcode) : '' };
        });
      migrateFloorguardV4toV5(); /* ensure seq counters exist on the mirror */
      /* Run 5: work-order audit rows join the local WO activity feed so
         holds, notes, assignments, and completions from other devices
         appear on job detail after a refresh. */
      (auditRows || []).filter(function (r) { return r.related_work_order_id; }).forEach(function (r) {
        var detail = '';
        var nv = r.new_value;
        if (typeof nv === 'string') { try { nv = JSON.parse(nv); } catch (e) { nv = null; } }
        if (r.action === 'WORK_ORDER_NOTE_ADDED' && nv && nv.text) detail = nv.text;
        else if (r.action === 'JOB_HELD' && nv && nv.reason) detail = 'Job placed ON HOLD: ' + nv.reason;
        else if (r.action === 'JOB_RESUMED') detail = 'Job resumed from hold.';
        else if (r.action === 'WAREHOUSE_WORK_STARTED') detail = 'Warehouse work started.';
        else if (r.action === 'WAREHOUSE_WORK_COMPLETED') detail = 'Warehouse work completed.';
        else if (r.action === 'EMPLOYEE_ASSIGNED' && nv) detail = 'Employee assigned.';
        fg.assignmentEvents.push({
          id: 'AE-' + r.id, at: r.created_at, action: r.action, user: r.user_name || '',
          warehouse: r.warehouse_id, workOrderId: r.related_work_order_id,
          lineId: null, rollId: r.related_roll_id || null, assignmentId: null,
          detail: detail
        });
      });
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
  'createDiscrepancy', 'reviewDiscrepancy',
  /* Run 5: scheduled jobs / daily warehouse queue */
  'getScheduledJobs', 'getJobsForDate', 'getMyScheduledJobs',
  'setJobHold', 'resumeJob', 'startWarehouseWork', 'assignEmployee',
  'completeWarehouseWork', 'addWorkOrderNote',
  /* Run 6: order + sales order foundation (+ Run 6 §0 reopen) */
  'reopenWarehouseWork',
  'createOrder', 'getOrder', 'updateOrderHeader', 'addOrderItem',
  'updateOrderItem', 'removeOrderItem', 'getDraftOrders',
  'getRecentSubmittedOrders', 'markOrderReady', 'submitOrder', 'deleteOrder',
  'getSalesOrders', 'getSalesOrder', 'releaseSalesOrderLine',
  'holdSalesOrder', 'resumeSalesOrder', 'cancelSalesOrder',
  /* Run 7: central numbering + loadout + receipts */
  'issueBusinessNumber',
  'getLoadouts', 'getLoadout', 'startLoadout', 'beginLoading',
  'verifyLoadoutLine', 'markLoadoutLineLoaded', 'createLoadoutException', 'completeLoadout',
  'getReceipts', 'getReceipt', 'createReceipt', 'addReceiptLine',
  'receiveRoll', 'createReceiptException', 'completeReceipt',
  'uploadReceiptDocument', 'getDocumentsForReceipt',
  /* Run 8: returns + returned material disposition */
  'getReturns', 'getReturn', 'getReturnItems', 'getReturnItem',
  'getReturnDispositions', 'getReturnedRemnants', 'getAvailableRemnants',
  'getReturnExceptions', 'getRemnantById',
  'createReturn', 'receiveReturn', 'addReturnItem', 'measureReturnItem',
  'inspectReturnItem', 'submitReturn', 'approveRestock', 'createReturnedRemnant',
  'assignRemnantInventory',
  'quarantineReturnItem', 'scrapReturnItem', 'sendReturnToVendor', 'holdReturnItem',
  'completeReturn', 'cancelReturn', 'raiseReturnException', 'resolveReturnException',
  'uploadReturnDocument', 'getDocumentsForReturn'
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

  /* Run 8: shared-mode remnant assignment. Validates locally, then calls the
     atomic reserve_remnant RPC, then applies the authoritative result. */
  assignRemnantInventory: function (o) {
    var v = (function () {
      var rem = (FG().returnedRemnants || []).filter(function (x) { return x.id === o.remnantId; })[0];
      if (!rem) return { ok: false, err: 'REMNANT NOT FOUND' };
      if (rem.status !== 'AVAILABLE') return { ok: false, err: 'REMNANT NOT AVAILABLE' };
      var wo = woById(o.woId);
      if (!wo) return { ok: false, err: 'WORK ORDER NOT FOUND' };
      var line = lineById(wo, o.lineId);
      if (!line) return { ok: false, err: 'MATERIAL LINE NOT FOUND' };
      var reservedIn = Math.round(Number(o.reservedIn) || 0);
      if (reservedIn <= 0) return { ok: false, err: 'RESERVED QUANTITY MUST BE GREATER THAN ZERO' };
      if (reservedIn > rem.lengthIn) return { ok: false, err: 'INSUFFICIENT REMNANT LENGTH' };
      var compat = checkCompatibility(rem, line);
      var mismatchBy = o.mismatchApprovedBy || null;
      if ((compat.verdict === 'MISMATCH' || compat.verdict === 'INCOMPLETE') &&
          !(mismatchBy && isSupervisorRole(mismatchBy)))
        return { ok: false, err: 'MATERIAL ' + compat.verdict + ' — SUPERVISOR APPROVAL REQUIRED', compat: compat };
      return { ok: true, rem: rem, wo: wo, line: line, reservedIn: reservedIn,
        compat: compat, mismatchBy: mismatchBy, employee: o.employee || DB.data.currentEmployee };
    })();
    if (!v.ok) return Promise.resolve(v);
    var self = this;
    return SharedRepo.assignRemnantInventory({
      workOrderId: v.wo.id, lineId: v.line.id, remnantId: v.rem.id,
      reservedIn: v.reservedIn, employee: v.employee,
      warehouseId: Repository.config.warehouseId,
      location: v.rem.locationCode || '',
      mismatchApprovedBy: v.mismatchBy,
      clientRequestId: o.clientRequestId || rid('AR')
    }).then(function (r) {
      var now = new Date().toISOString();
      var rec = {
        id: r.assignmentId, workOrderId: v.wo.id, lineId: v.line.id,
        remnantId: v.rem.id, remnantNumber: r.remnantNumber || v.rem.number, rollId: null,
        requiredIn: v.line.requiredIn, reservedIn: v.reservedIn,
        employee: v.employee, warehouseId: Repository.config.warehouseId,
        location: v.rem.locationCode || '',
        at: now, status: 'RESERVED',
        mismatchApprovedBy: v.mismatchBy,
        rollVerifiedAt: null, rollVerifiedBy: null,
        locationVerifiedAt: null, locationVerifiedBy: null,
        releasedAt: null, releasedBy: null,
        consumedAt: null, consumedBy: null, cutId: null, actualCutIn: null
      };
      FG().inventoryAssignments.push(rec);
      v.rem.status = 'ASSIGNED'; v.rem.updatedAt = now;
      logAssignEvent('REMNANT_ASSIGNED', {
        user: v.employee, workOrderId: v.wo.id, lineId: v.line.id,
        remnantId: v.rem.id, assignmentId: rec.id,
        detail: 'Remnant ' + rec.remnantNumber + ' → ' + v.wo.number + ' line ' + v.line.id +
          ', reserved ' + fmtLen(v.reservedIn)
      });
      DB.save();
      return { ok: true, rec: rec, compat: v.compat, duplicate: !!r.duplicate };
    });
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
