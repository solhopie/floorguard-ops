/* ============================================================
   FLOORGUARD OPS — Run 1: application foundation + navigation
   Static SPA, no build step, no network dependencies.
   Storage: localStorage key "floorguard_ops_v1".
   Later runs add modules under Screens + MODULE_INFO and store
   their data in DB.ns('<module-key>') — the data layer seam.
   ============================================================ */
'use strict';

/* ---------------- utilities ---------------- */
function $(sel) { return document.querySelector(sel); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function todayStr() {
  var d = new Date();
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
}
function daypart() {
  var h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

var APP_VERSION = '0.6.0';

/* ---------------- data layer ----------------
   One localStorage key, schema version, per-module namespaces.
   Modules never touch each other's data: they read/write only
   through DB.ns('<module-key>'). */
var DB = {
  KEY: 'floorguard_ops_v1',
  SCHEMA: 5,
  data: null,
  seed: function () {
    return {
      schema: 5,
      currentEmployee: null,
      employees: ['Marcus', 'Dana', 'Luis'],
      employeeRoles: { Marcus: 'MANAGER', Dana: 'WORKER', Luis: 'WORKER' },
      /* Run 6 §0: every warehouse carries an explicit IANA timezone.
         Warehouse-local date, reports, and audit display always use it —
         never the tablet/browser timezone alone. */
      warehouses: [{ id: 'main', name: 'Main Warehouse', timezone: 'America/New_York' }],
      currentWarehouse: 'main',
      modules: {},       /* per-module namespaces, created on demand via DB.ns() */
      settings: {}
    };
  },
  load: function () {
    try {
      var raw = localStorage.getItem(this.KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && d.schema === 5) { this.data = d; ensureFloorguardStore(); return; }
        if (d && d.schema === 4) {
          /* v4 -> v5: Run 6. Explicit warehouse timezone (America/New_York
             default — the pilot warehouse's real zone; never the browser's).
             Run 6 order collections are initialized by ensureFloorguardStore. */
          (d.warehouses || []).forEach(function (w) { if (!w.timezone) w.timezone = 'America/New_York'; });
          d.schema = 5;
          this.data = d;
          migrateFloorguardV3toV4();
          migrateFloorguardV4toV5();
          this.save();
          return;
        }
        if (d && d.schema === 3) {
          /* v3 -> v4 -> v5: Run 5 scheduled-job fields, then Run 6 order
             collections + explicit warehouse timezone. */
          (d.warehouses || []).forEach(function (w) { if (!w.timezone) w.timezone = 'America/New_York'; });
          d.schema = 5;
          this.data = d;
          migrateFloorguardV3toV4();
          migrateFloorguardV4toV5();
          this.save();
          return;
        }
        if (d && d.schema === 2) {
          /* v2 -> v3: Run 3 inventory assignment collections + work-order
             material lines. Existing roll links and balances are untouched. */
          d.schema = 3;
          this.data = d;
          migrateFloorguardV2toV3();
          migrateFloorguardV3toV4();
          migrateFloorguardV4toV5();
          d.schema = 5;
          this.save();
          return;
        }
        if (d && d.schema === 1) {
          /* v1 -> v2: add warehouse context + roles, seed the shared
             FloorGuard inventory store. Run 1 session data is kept. */
          d.schema = 5;
          if (!d.warehouses) d.warehouses = [{ id: 'main', name: 'Main Warehouse', timezone: 'America/New_York' }];
          if (!d.currentWarehouse) d.currentWarehouse = 'main';
          if (!d.employeeRoles) d.employeeRoles = { Marcus: 'MANAGER', Dana: 'WORKER', Luis: 'WORKER' };
          this.data = d;
          migrateFloorguardV2toV3();
          migrateFloorguardV3toV4();
          migrateFloorguardV4toV5();
          this.save();
          return;
        }
      }
    } catch (e) { /* corrupted or unavailable storage -> reseed */ }
    this.data = this.seed();
    ensureFloorguardStore();
    this.save();
  },
  save: function () {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); } catch (e) {}
  },
  /* Isolated data area for one module. Created on demand. */
  ns: function (name) {
    if (!this.data.modules[name]) { this.data.modules[name] = {}; this.save(); }
    return this.data.modules[name];
  },
  reset: function () { this.data = this.seed(); ensureFloorguardStore(); this.save(); }
};

/* ---------------- shared FloorGuard inventory store ----------------
   ONE roll database for the whole product: Carpet Roll, Cut Transaction,
   Cycle Count Session/Record, discovered rolls/locations, Documents
   (history cards), and Work Orders. Ported from the legacy prototype's
   tested seed; this store is now the source of truth. */
/* Run 6: order / sales-order demo fixtures. Fresh objects on every call.
   Shared by the schema-5 seed and the v4->v5 migration so upgraded stores
   get the same fixtures a fresh install has. */
function run6Fixtures(at, dstr, D) {
  return {
    orders: [
      /* Fictional development order (SUBMITTED): the source behind SO-100245. */
      { id: 'ORD-1000', number: 'ORD-1000', property: 'Ventura Pointe', account: 'Willowbridge',
        requestedDate: dstr(-2), scheduledDate: dstr(0), priority: 'NORMAL',
        createdBy: 'Marcus', warehouseId: 'main', internalRef: 'DEV-REF-1',
        notes: 'Fictional development order.', status: 'SUBMITTED',
        items: [
          { id: 'ORD-1000-I1', seq: 1, style: 'Marvel', color: 'Chrome', materialType: 'CARPET',
            uom: 'LF', widthIn: 144, quantityIn: 237, quantity: null, notes: '' },
          { id: 'ORD-1000-I2', seq: 2, style: 'Rebond Pad', color: 'Natural', materialType: 'PAD',
            uom: 'LF', widthIn: 144, quantityIn: 237, quantity: null, notes: '' }
        ],
        createdAt: at(2 * D), updatedAt: at(2 * D), submittedAt: at(2 * D), salesOrderId: 'SO-100245' },
      /* Fictional draft order: a starting point for the Order walkthrough. */
      { id: 'ORD-1001', number: 'ORD-1001', property: '', account: '',
        requestedDate: dstr(3), scheduledDate: '', priority: 'NORMAL',
        createdBy: 'Marcus', warehouseId: 'main', internalRef: '',
        notes: '', status: 'DRAFT',
        items: [],
        createdAt: at(1 * D), updatedAt: at(1 * D), submittedAt: null, salesOrderId: null }
    ],
    salesOrders: [
      /* Fictional development sales order: OPEN, two lines, none released. */
      { id: 'SO-100245', number: 'SO-100245', sourceOrderId: 'ORD-1000',
        property: 'Ventura Pointe', account: 'Willowbridge', warehouseId: 'main',
        priority: 'NORMAL', requestedDate: dstr(-2), scheduledDate: dstr(0),
        status: 'OPEN', createdBy: 'Marcus', submittedBy: 'Marcus',
        createdAt: at(2 * D), submittedAt: at(2 * D), updatedAt: at(2 * D),
        notes: 'Fictional development sales order.',
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        lines: [
          { id: 'SO-100245-L1', seq: 1, sourceItemId: 'ORD-1000-I1',
            style: 'Marvel', color: 'Chrome', materialType: 'CARPET',
            uom: 'LF', widthIn: 144, orderedIn: 237, orderedQty: null,
            warehouseQtyRequired: 237, status: 'OPEN', workOrderId: null },
          { id: 'SO-100245-L2', seq: 2, sourceItemId: 'ORD-1000-I2',
            style: 'Rebond Pad', color: 'Natural', materialType: 'PAD',
            uom: 'LF', widthIn: 144, orderedIn: 237, orderedQty: null,
            warehouseQtyRequired: 237, status: 'OPEN', workOrderId: null }
        ] }
    ],
    orderEvents: [],
    seq: { order: 1002, salesOrder: 100246, workOrder: 2001 }
  };
}

function seedFloorguard() {
  var now = Date.now();
  var H = 3600 * 1000, D = 24 * H;
  var at = function (msAgo) { return new Date(now - msAgo).toISOString(); };
  /* Run 5: warehouse-local calendar date string, dayOffset from today. */
  var dstr = function (dayOffset) {
    var d = new Date(now + dayOffset * D);
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  };
  var store = {
    rolls: [
      { id: 'QH5CPHN', barcode: 'QH5CPHN', manufacturer: 'Shaw Industries',
        style: 'Venture Solid', color: 'Soft Taupe', widthIn: 144,
        beginningIn: 1801, expectedLocation: '205B' },
      { id: 'TK7M2QA', barcode: 'TK7M2QA', manufacturer: 'Mohawk Industries',
        style: 'EverStrand Soft', color: 'Harbor Gray', widthIn: 144,
        beginningIn: 1440, expectedLocation: '205A' },
      { id: 'PL9XD4R', barcode: 'PL9XD4R', manufacturer: 'DreamWeaver',
        style: 'Pure Earth', color: 'Desert Sand', widthIn: 180,
        beginningIn: 1680, expectedLocation: '206B' },
      { id: 'MN3KP8W', barcode: 'MN3KP8W', manufacturer: 'Shaw Industries',
        style: 'Tuftex Nylon', color: 'Midnight Blue', widthIn: 144,
        beginningIn: 1560, expectedLocation: '206A' },
      { id: 'QW8ZV2N', barcode: 'QW8ZV2N', manufacturer: 'Phenix Flooring',
        style: 'Karastan Wool', color: 'Ivory White', widthIn: 162,
        beginningIn: 1320, expectedLocation: '204B' },
      { id: 'ZX4LM7B', barcode: 'ZX4LM7B', manufacturer: 'Stanton Carpet',
        style: 'Atelier Wool', color: 'Charcoal', widthIn: 144,
        beginningIn: 1200, expectedLocation: '204A' },
      /* Run 3 inventory-assignment demo rolls: Marvel / Chrome 12 FT carpet.
         16628697 holds 1034" (86' 2") — the assignment demo roll. */
      { id: '16628697', barcode: '16628697', manufacturer: 'Shaw',
        style: 'Marvel', color: 'Chrome', materialType: 'Carpet', widthIn: 144,
        beginningIn: 1034, expectedLocation: '205B' },
      { id: '16628698', barcode: '16628698', manufacturer: 'Shaw',
        style: 'Marvel', color: 'Chrome', materialType: 'Carpet', widthIn: 144,
        beginningIn: 366, expectedLocation: '206B' },
      /* Run 5: dedicated roll for the completed-demo work order XS024542. */
      { id: '16628699', barcode: '16628699', manufacturer: 'Shaw',
        style: 'Marvel', color: 'Chrome', materialType: 'Carpet', widthIn: 144,
        beginningIn: 500, expectedLocation: '204A' }
    ],
    discovered: [],   /* { id, raw, firstSeenAt, firstSeenBy, lastLocation,
                          lastMeasuredIn, lastMeasuredAt, lastMeasuredBy, count } */
    cuts: [
      { id: 'K1', rollId: 'QH5CPHN', barcode: 'QH5CPHN', order: 'XS024531', inches: 323, prevIn: 1801, newIn: 1478, location: '205B', at: at(3 * D + 5 * H), by: 'Marcus' },
      { id: 'K2', rollId: 'QH5CPHN', barcode: 'QH5CPHN', order: 'XS024532', inches: 444, prevIn: 1478, newIn: 1034, location: '205B', at: at(2 * D + 3 * H), by: 'Dana' },
      { id: 'K3', rollId: 'QH5CPHN', barcode: 'QH5CPHN', order: 'XS024531', inches: 498, prevIn: 1034, newIn: 536, location: '205B', at: at(1 * D + 6 * H), by: 'Marcus' },
      { id: 'K4', rollId: 'TK7M2QA', barcode: 'TK7M2QA', order: 'XS024540', inches: 200, prevIn: 1440, newIn: 1240, location: '205A', at: at(2 * D + 8 * H), by: 'Dana' },
      { id: 'K5', rollId: 'PL9XD4R', barcode: 'PL9XD4R', order: 'XS024531', inches: 360, prevIn: 1680, newIn: 1320, location: '206B', at: at(4 * D + 2 * H), by: 'Luis' },
      { id: 'K6', rollId: 'QW8ZV2N', barcode: 'QW8ZV2N', order: 'XS024532', inches: 120, prevIn: 1320, newIn: 1200, location: '204B', at: at(5 * D + 4 * H), by: 'Marcus' },
      /* Run 5: the cut that consumed assignment A-SEED1 on the completed demo job. */
      { id: 'K7', rollId: '16628699', barcode: '16628699', order: 'XS024542', inches: 240, prevIn: 500, newIn: 260, location: '204A', at: at(1 * D + 2 * H), by: 'Marcus' }
    ],
    counts: [
      { id: 'C-SEED-1', rollId: 'QH5CPHN', style: 'Venture Solid', color: 'Soft Taupe',
        widthIn: 144, expectedLocation: '205B', scannedLocation: '205B',
        expectedIn: 536, physicalIn: 533, diffIn: -3,
        employee: 'Marcus', at: at(2 * H), status: 'SHORT', flagged: false, measured: true },
      { id: 'C-SEED-2', rollId: 'TK7M2QA', style: 'EverStrand Soft', color: 'Harbor Gray',
        widthIn: 144, expectedLocation: '205A', scannedLocation: '205A',
        expectedIn: 1240, physicalIn: 1240, diffIn: 0,
        employee: 'Dana', at: at(5 * H), status: 'MATCH', flagged: false, measured: true },
      { id: 'C-SEED-3', rollId: 'TK7M2QA', style: 'EverStrand Soft', color: 'Harbor Gray',
        widthIn: 144, expectedLocation: '205A', scannedLocation: '205A',
        expectedIn: 1240, physicalIn: 1240, diffIn: 0,
        employee: 'Luis', at: at(0.5 * H), status: 'MATCH', flagged: false, measured: true },
      { id: 'C-SEED-4', rollId: 'PL9XD4R', style: 'Pure Earth', color: 'Desert Sand',
        widthIn: 180, expectedLocation: '206B', scannedLocation: '206B',
        expectedIn: 1320, physicalIn: 1350, diffIn: 30,
        employee: 'Luis', at: at(3 * H), status: 'OVER', flagged: false, measured: true },
      { id: 'C-SEED-5', rollId: 'MN3KP8W', style: 'Tuftex Nylon', color: 'Midnight Blue',
        widthIn: 144, expectedLocation: '206A', scannedLocation: '206B',
        expectedIn: 1560, physicalIn: 1560, diffIn: 0,
        employee: 'Dana', at: at(1 * H), status: 'LOCATION_MISMATCH', flagged: false, measured: true },
      { id: 'C-SEED-6', rollId: 'QW8ZV2N', style: 'Karastan Wool', color: 'Ivory White',
        widthIn: 162, expectedLocation: '204B', scannedLocation: '204A',
        expectedIn: 1200, physicalIn: 1190, diffIn: -10,
        employee: 'Marcus', at: at(0.75 * H), status: 'NEEDS_REVIEW', flagged: true, measured: true }
    ],
    freeSessions: [],  /* { id, startedAt, startedBy, warehouse, endedAt } */
    freeCounts: [],    /* { id, sessionId, rollId, barcode, raw, discovered, location,
                           measuredFt, measuredInch, physicalIn, expectedIn (null when unknown),
                           status: 'COLLECTED', measured: true, employee, at, date, time } */
    documents: [],     /* history-card captures: { id, rollId, barcode, raw, discovered,
                           kind: 'HISTORY_CARD', docType, image, thumb, employee, at,
                           date, time, location, source: 'PAPER CARD', num, imports: [] } */
    workOrders: [
      /* Run 3: material lines live on the work order. requiredIn is integer
         inches; status is DERIVED from active inventory assignments —
         never stored, so it cannot drift. */
      { id: 'WO-1001', number: 'WO-1001', property: 'Maple St Residence', account: 'Acme Flooring Co',
        style: 'Venture Solid', color: 'Soft Taupe', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 850, rollId: 'QH5CPHN', assigneeId: 'e1',
        opStatus: 'IN_PROGRESS', createdAt: at(6 * D),
        priority: 'NORMAL', scheduledDate: null, scheduledTime: null,
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        lines: [{ id: 'WO-1001-L1', style: 'Venture Solid', color: 'Soft Taupe', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 850 }] },
      { id: 'WO-1002', number: 'WO-1002', property: 'Oak Ave Residence', account: 'Acme Flooring Co',
        style: 'EverStrand Soft', color: 'Harbor Gray', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 620, rollId: 'TK7M2QA', assigneeId: null,
        opStatus: 'OPEN', createdAt: at(5 * D),
        priority: 'NORMAL', scheduledDate: null, scheduledTime: null,
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        lines: [{ id: 'WO-1002-L1', style: 'EverStrand Soft', color: 'Harbor Gray', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 620 }] },
      { id: 'WO-1003', number: 'WO-1003', property: 'Pine Rd Residence', account: 'HomeStyle Interiors',
        style: 'Pure Earth', color: 'Desert Sand', materialType: 'Carpet', uom: 'LF',
        widthIn: 180, quantity: 400, rollId: null, assigneeId: 'e2',
        opStatus: 'OPEN', createdAt: at(4 * D),
        priority: 'NORMAL', scheduledDate: null, scheduledTime: null,
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        lines: [{ id: 'WO-1003-L1', style: 'Pure Earth', color: 'Desert Sand', materialType: 'Carpet',
          uom: 'LF', widthIn: 180, requiredIn: 400 }] },
      { id: 'WO-1004', number: 'WO-1004', property: 'Cedar Ln Residence', account: 'Acme Flooring Co',
        style: 'Tuftex Nylon', color: 'Midnight Blue', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 300, rollId: null, assigneeId: null,
        opStatus: 'OPEN', createdAt: at(3 * D),
        priority: 'NORMAL', scheduledDate: null, scheduledTime: null,
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        lines: [{ id: 'WO-1004-L1', style: 'Tuftex Nylon', color: 'Midnight Blue', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 300 }] },
      /* Run 3 assignment demo orders: Marvel / Chrome 12 FT carpet. */
      { id: 'XS024536', number: 'XS024536', property: 'Ventura Pointe', account: 'Willowbridge',
        style: 'Marvel', color: 'Chrome', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 237, rollId: null, assigneeId: 'e1',
        opStatus: 'OPEN', createdAt: at(2 * D),
        priority: 'HIGH', scheduledDate: dstr(0), scheduledTime: '09:00',
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        lines: [{ id: 'XS024536-L1', style: 'Marvel', color: 'Chrome', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 237 }] },
      { id: 'XS024537', number: 'XS024537', property: 'Harbor Ridge', account: 'Willowbridge',
        style: 'Marvel', color: 'Chrome', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 495, rollId: null, assigneeId: 'e2',
        opStatus: 'OPEN', createdAt: at(1 * D),
        priority: 'NORMAL', scheduledDate: dstr(1), scheduledTime: '10:30',
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        lines: [{ id: 'XS024537-L1', style: 'Marvel', color: 'Chrome', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 495 }] },
      /* Run 5 demo queue: today / upcoming / in-progress / completed /
         unassigned / on-hold examples around the XS orders. */
      { id: 'XS024541', number: 'XS024541', property: 'Cedar Bluff', account: 'Willowbridge',
        style: 'Tuftex Nylon', color: 'Midnight Blue', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 300, rollId: null, assigneeId: null,
        opStatus: 'OPEN', createdAt: at(1 * D),
        priority: 'URGENT', scheduledDate: dstr(0), scheduledTime: '08:00',
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        lines: [{ id: 'XS024541-L1', style: 'Tuftex Nylon', color: 'Midnight Blue', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 300 }] },
      { id: 'XS024542', number: 'XS024542', property: 'Stonebridge', account: 'Willowbridge',
        style: 'Marvel', color: 'Chrome', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 240, rollId: '16628699', assigneeId: 'e1',
        opStatus: 'COMPLETE', createdAt: at(2 * D),
        priority: 'NORMAL', scheduledDate: dstr(-1), scheduledTime: '09:00',
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: at(20 * H), warehouseCompletedBy: 'Marcus',
        lines: [{ id: 'XS024542-L1', style: 'Marvel', color: 'Chrome', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 240 }] },
      { id: 'XS024543', number: 'XS024543', property: 'Fox Hollow', account: 'Willowbridge',
        style: 'Marvel', color: 'Chrome', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 180, rollId: null, assigneeId: 'e2',
        opStatus: 'OPEN', createdAt: at(1 * D),
        priority: 'HIGH', scheduledDate: dstr(0), scheduledTime: '13:00',
        onHold: true, holdReason: 'MATERIAL NOT FOUND', holdAt: at(2 * H), holdBy: 'Dana',
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        lines: [{ id: 'XS024543-L1', style: 'Marvel', color: 'Chrome', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 180 }] },
      { id: 'XS024544', number: 'XS024544', property: 'River Oaks', account: 'Willowbridge',
        style: 'Marvel', color: 'Chrome', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 150, rollId: '16628697', assigneeId: 'e1',
        opStatus: 'IN_PROGRESS', createdAt: at(1 * D),
        priority: 'NORMAL', scheduledDate: dstr(0), scheduledTime: '07:30',
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        startedAt: at(3 * H), startedBy: 'Marcus',
        lines: [{ id: 'XS024544-L1', style: 'Marvel', color: 'Chrome', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 150 }] },
      { id: 'XS024545', number: 'XS024545', property: 'Lakeshore', account: 'Harbor & Vine',
        style: 'EverStrand Soft', color: 'Harbor Gray', materialType: 'Carpet', uom: 'LF',
        widthIn: 144, quantity: 420, rollId: null, assigneeId: null,
        opStatus: 'OPEN', createdAt: at(1 * D),
        priority: 'NORMAL', scheduledDate: dstr(3), scheduledTime: '09:30',
        onHold: false, holdReason: null, holdAt: null, holdBy: null,
        warehouseCompletedAt: null, warehouseCompletedBy: null,
        lines: [{ id: 'XS024545-L1', style: 'EverStrand Soft', color: 'Harbor Gray', materialType: 'Carpet',
          uom: 'LF', widthIn: 144, requiredIn: 420 }] }
    ],
    /* Run 3: inventory reservations. Append-only records — reservations NEVER
       change roll balances; only cut transactions do.
       Run 5: one seeded CONSUMED assignment backing the completed demo job. */
    inventoryAssignments: [
      { id: 'A-SEED1', workOrderId: 'XS024542', lineId: 'XS024542-L1', rollId: '16628699',
        discovered: false, requiredIn: 240, reservedIn: 240,
        employee: 'Marcus', warehouseId: 'main', location: '204A',
        at: at(1 * D + 3 * H), status: 'CONSUMED',
        mismatchApprovedBy: null, overApprovedBy: null,
        rollVerifiedAt: at(1 * D + 3 * H), rollVerifiedBy: 'Marcus',
        locationVerifiedAt: null, locationVerifiedBy: null,
        releasedAt: null, releasedBy: null,
        consumedAt: at(1 * D + 2 * H), consumedBy: 'Marcus', cutId: 'K7', actualCutIn: 240 }
    ],
    /* Run 3: append-only audit trail for every assignment action. */
    assignmentEvents: []
  };
  /* Run 6: order / sales-order fixtures (shared with the v4->v5 migration). */
  var f6 = run6Fixtures(at, dstr, D);
  store.orders = f6.orders;
  store.salesOrders = f6.salesOrders;
  store.orderEvents = f6.orderEvents;
  store.seq = f6.seq;
  return store;
}

/* The single FloorGuard inventory store. Every roll/cut/count/document/
   work-order read and write goes through here — no duplicate databases. */
function FG() { return DB.ns('floorguard'); }

function ensureFloorguardStore() {
  if (!DB.data.modules['floorguard']) {
    DB.data.modules['floorguard'] = seedFloorguard();
    DB.save();
  }
  migrateFloorguardV4toV5();
}

/* Run 6 (schema 5): order / sales-order collections on existing stores.
   Idempotent — safe to run on fresh seeds and migrated stores alike. */
function migrateFloorguardV4toV5() {
  var fg = DB.data.modules['floorguard'];
  if (!fg) return;
  /* Backfill the Run 6 demo fixtures on stores that predate them, so an
     upgraded device sees the same SO-100245 / ORD-1000 / ORD-1001 a fresh
     install has. Only when the collections are absent — never clobber
     orders the user already created. */
  if (!fg.orders || !fg.salesOrders) {
    var now = Date.now(), D = 24 * 3600 * 1000;
    var at = function (msAgo) { return new Date(now - msAgo).toISOString(); };
    var dstr = function (dayOffset) {
      var d = new Date(now + dayOffset * D);
      var m = d.getMonth() + 1, day = d.getDate();
      return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
    };
    var f6 = run6Fixtures(at, dstr, D);
    if (!fg.orders) fg.orders = f6.orders;
    if (!fg.salesOrders) fg.salesOrders = f6.salesOrders;
    if (!fg.orderEvents) fg.orderEvents = f6.orderEvents;
  }
  if (!fg.seq) fg.seq = { order: 1002, salesOrder: 100246, workOrder: 2001 };
  /* Traceability fields on work orders (Run 6 §20/§22). */
  (fg.workOrders || []).forEach(function (w) {
    if (!('salesOrderId' in w)) w.salesOrderId = null;
    if (!('salesOrderLineId' in w)) w.salesOrderLineId = null;
  });
}

/* Reseed ONLY the inventory store (demo data). Session, employees,
   warehouse context, and other module namespaces are untouched. */
function FGReset() {
  DB.data.modules['floorguard'] = seedFloorguard();
  DB.save();
}

/* Run 3 (schema 3): add inventory-assignment collections and material lines
   to an existing schema-2 FloorGuard store. Balances, cuts, counts, roll
   links, and history are untouched. */
function migrateFloorguardV2toV3() {
  var fg = DB.data.modules['floorguard'];
  if (!fg) { ensureFloorguardStore(); return; }
  if (!fg.inventoryAssignments) fg.inventoryAssignments = [];
  if (!fg.assignmentEvents) fg.assignmentEvents = [];
  (fg.workOrders || []).forEach(function (w) {
    if (!w.lines || !w.lines.length) {
      w.lines = [{ id: w.id + '-L1', style: w.style, color: w.color,
        materialType: w.materialType, uom: w.uom, widthIn: w.widthIn,
        requiredIn: Math.round(Number(w.quantity) || 0) }];
    }
  });
  DB.save();
}

/* Run 5 (schema 4): scheduling fields on work orders. Existing balances,
   cuts, counts, assignments, and history are untouched. */
function migrateFloorguardV3toV4() {
  var fg = DB.data.modules['floorguard'];
  if (!fg) { ensureFloorguardStore(); return; }
  (fg.workOrders || []).forEach(function (w) {
    if (w.priority == null) w.priority = 'NORMAL';
    if (w.scheduledDate === undefined) w.scheduledDate = null;
    if (w.scheduledTime === undefined) w.scheduledTime = null;
    if (w.onHold === undefined) w.onHold = false;
    if (w.holdReason === undefined) w.holdReason = null;
    if (w.holdAt === undefined) w.holdAt = null;
    if (w.holdBy === undefined) w.holdBy = null;
    if (w.warehouseCompletedAt === undefined) w.warehouseCompletedAt = null;
    if (w.warehouseCompletedBy === undefined) w.warehouseCompletedBy = null;
  });
  DB.save();
}

/* ---------------- inventory assignment service (Run 3) ----------------
   One shared store: work orders <-> material lines <-> inventory
   assignments <-> rolls <-> cuts <-> roll history. No second database.
   Reserving inventory NEVER changes a roll's trusted balance — only a
   recorded CUT transaction changes it. */
var AI_STATUS = { RESERVED: 'RESERVED', RELEASED: 'RELEASED', CONSUMED: 'CONSUMED' };

function aiSeq() {
  return 'A' + Date.now().toString(36).toUpperCase().slice(-6) +
    Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0');
}
function aeSeq() {
  return 'E' + Date.now().toString(36).toUpperCase().slice(-8) +
    Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
}
function isSupervisorRole(name) {
  var r = (DB.data.employeeRoles || {})[name];
  return r === 'MANAGER' || r === 'ADMIN' || r === 'SUPERVISOR';
}
function lineById(wo, lineId) {
  return ((wo && wo.lines) || []).filter(function (l) { return l.id === lineId; })[0] || null;
}
/* A roll record OR a discovered-roll record — both are assignable entities
   in the shared store. Discovered rolls carry no style/color, so they always
   route through supervisor review (MATERIAL DATA INCOMPLETE). */
function assignableRoll(id) {
  var r = rollById(id);
  if (r) return r;
  return (typeof findDiscovered === 'function') ? findDiscovered(id) : null;
}
function isDiscoveredRoll(roll) { return !!(roll && roll.beginningIn == null); }
/* Balance the assignment math can use: trusted system balance for known
   rolls, the measured balance captured at discovery for unknown rolls,
   null when nothing is known (supervisor review required). */
function assignableBalance(roll) {
  if (!roll) return null;
  if (!isDiscoveredRoll(roll)) return systemBalance(roll.id);
  return (roll.lastMeasuredIn != null) ? roll.lastMeasuredIn : null;
}
function activeAssignments(woId, lineId) {
  return (FG().inventoryAssignments || []).filter(function (a) {
    return a.workOrderId === woId && a.lineId === lineId && a.status === AI_STATUS.RESERVED;
  });
}
function allAssignmentsForLine(woId, lineId) {
  return (FG().inventoryAssignments || []).filter(function (a) {
    return a.workOrderId === woId && a.lineId === lineId;
  });
}
/* Total inches currently RESERVED against one roll across ALL work orders.
   One roll entity, many assignments — the roll is never duplicated. */
function reservedOnRoll(rollId) {
  return (FG().inventoryAssignments || []).filter(function (a) {
    return a.rollId === rollId && a.status === AI_STATUS.RESERVED;
  }).reduce(function (s, a) { return s + (a.reservedIn || 0); }, 0);
}
/* Informational "potential available" — never alters the trusted balance. */
function potentialAvailable(roll) {
  var bal = assignableBalance(roll);
  return (bal == null) ? null : bal - reservedOnRoll(roll.id);
}
function lineStatus(wo, line) {
  var all = allAssignmentsForLine(wo.id, line.id);
  var act = all.filter(function (a) { return a.status === AI_STATUS.RESERVED; });
  if (act.length) {
    var tot = act.reduce(function (s, a) { return s + (a.reservedIn || 0); }, 0);
    return tot >= (line.requiredIn || 0) ? 'ASSIGNED' : 'PARTIALLY_ASSIGNED';
  }
  /* No active reservation, but the line was already cut for: the material
     left the roll through a real cut transaction, so the line is fulfilled —
     it must not fall back to NOT ASSIGNED and reappear as needing inventory. */
  var cons = all.filter(function (a) { return a.status === AI_STATUS.CONSUMED; });
  if (cons.length) {
    var cut = cons.reduce(function (s, a) {
      return s + (a.actualCutIn != null ? a.actualCutIn : (a.reservedIn || 0));
    }, 0);
    return cut >= (line.requiredIn || 0) ? 'COMPLETED' : 'PARTIALLY_ASSIGNED';
  }
  return 'NOT_ASSIGNED';
}
/* NOT ASSIGNED / PARTIALLY ASSIGNED / ASSIGNED against the material line. */
function checkCompatibility(roll, line) {
  var fields = [
    ['style', roll.style, line.style],
    ['color', roll.color, line.color],
    ['widthIn', roll.widthIn, line.widthIn],
    ['materialType', roll.materialType, line.materialType]
  ];
  var missing = [], mismatch = [];
  fields.forEach(function (f) {
    var rv = f[1], lv = f[2];
    if (rv == null || rv === '' || lv == null || lv === '') { missing.push(f[0]); return; }
    var same = (f[0] === 'widthIn')
      ? Number(rv) === Number(lv)
      : String(rv).trim().toLowerCase() === String(lv).trim().toLowerCase();
    if (!same) mismatch.push({ field: f[0], roll: rv, line: lv });
  });
  if (mismatch.length) return { verdict: 'MISMATCH', mismatches: mismatch, missing: missing };
  if (missing.length) return { verdict: 'INCOMPLETE', mismatches: [], missing: missing };
  return { verdict: 'MATCH', mismatches: [], missing: [] };
}
function overReserved(rollId, newReservedIn) {
  var roll = assignableRoll(rollId);
  var bal = assignableBalance(roll);
  if (bal == null) return { over: false, unknown: true, total: null, balance: null };
  var total = reservedOnRoll(rollId) + newReservedIn;
  return { over: total > bal, unknown: false, total: total, balance: bal };
}
/* ---------------- scheduled jobs / daily warehouse queue (Run 5) --------
   Scheduled Jobs ARE Work Orders — no second scheduling database. Every
   value below is DERIVED from work orders + material lines + inventory
   assignments + cuts + audit events. Readiness is never stored, so it
   cannot drift. */

/* Warehouse-local calendar date as YYYY-MM-DD. */
/* Run 6 §0: explicit IANA timezone per warehouse. Warehouse-local date,
   scheduled-job grouping, reports, and audit display always derive from
   this — never from the tablet/browser timezone alone. */
function warehouseRecord() {
  return ((DB.data && DB.data.warehouses) || [])
    .filter(function (w) { return w.id === DB.data.currentWarehouse; })[0] || {};
}
function warehouseTimezone() {
  return warehouseRecord().timezone || 'America/New_York';
}
/* Warehouse-local 'YYYY-MM-DD'. */
function warehouseToday() {
  try {
    /* en-CA formats as YYYY-MM-DD. */
    return new Intl.DateTimeFormat('en-CA', { timeZone: warehouseTimezone() }).format(new Date());
  } catch (e) {
    var d = new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }
}
/* Audit/activity timestamps, rendered in the warehouse timezone. */
function fmtAuditTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString([], {
      timeZone: warehouseTimezone(), month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  } catch (e) {
    return fmtDT(iso);
  }
}
/* 'YYYY-MM-DD' -> Date at local midnight. */
function dateStrToDate(ds) {
  var p = String(ds || '').split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function addDaysStr(ds, n) {
  var d = dateStrToDate(ds);
  d.setDate(d.getDate() + n);
  var m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}
/* Current employee name -> 'eN' assignee id, or null. */
function currentAssigneeId() {
  var name = (typeof DB !== 'undefined' && DB.data) ? DB.data.currentEmployee : null;
  var i = ((DB.data && DB.data.employees) || []).indexOf(name);
  return i >= 0 ? 'e' + (i + 1) : null;
}

/* All cut transactions recorded against one work order (by printed number). */
function woCuts(wo) {
  return (FG().cuts || []).filter(function (c) { return c.order === wo.number; });
}
/* Readiness states — derived, never stored. */
var JOB_STATES = {
  WAITING_FOR_INVENTORY: 'WAITING FOR INVENTORY',
  INVENTORY_ASSIGNED: 'INVENTORY ASSIGNED',
  READY_TO_CUT: 'READY TO CUT',
  IN_PROGRESS: 'IN PROGRESS',
  CUT_COMPLETE: 'CUT COMPLETE',
  READY_FOR_NEXT_STEP: 'READY FOR NEXT STEP',
  COMPLETED: 'COMPLETED',
  ON_HOLD: 'ON HOLD',
  CANCELLED: 'CANCELLED'
};
/* Per-line progress: WAITING FOR INVENTORY / INVENTORY ASSIGNED /
   READY TO CUT / CUT COMPLETE — from the same lineStatus() Run 3 uses. */
function lineProgress(wo, line) {
  var st = lineStatus(wo, line);
  if (st === 'COMPLETED') return 'CUT COMPLETE';
  if (st === 'ASSIGNED') return 'READY TO CUT';
  if (st === 'PARTIALLY_ASSIGNED') return 'INVENTORY ASSIGNED';
  return 'WAITING FOR INVENTORY';
}
/* The derived readiness of a whole work order (spec section 6). */
function jobReadiness(wo) {
  if (!wo) return JOB_STATES.WAITING_FOR_INVENTORY;
  if (wo.opStatus === 'CANCELLED') return JOB_STATES.CANCELLED;
  if (wo.onHold) return JOB_STATES.ON_HOLD;
  if (wo.opStatus === 'COMPLETE' || wo.warehouseCompletedAt) return JOB_STATES.COMPLETED;
  var lines = wo.lines || [];
  if (!lines.length) return JOB_STATES.WAITING_FOR_INVENTORY;
  var prog = lines.map(function (l) { return lineProgress(wo, l); });
  var done = prog.filter(function (p) { return p === 'CUT COMPLETE'; }).length;
  if (done === lines.length) return JOB_STATES.READY_FOR_NEXT_STEP;
  if (wo.opStatus === 'IN_PROGRESS') return JOB_STATES.IN_PROGRESS;
  if (done > 0) return JOB_STATES.CUT_COMPLETE;
  var ready = prog.filter(function (p) { return p === 'READY TO CUT'; }).length;
  if (ready === lines.length) return JOB_STATES.READY_TO_CUT;
  var anyRes = prog.some(function (p) { return p !== 'WAITING FOR INVENTORY'; });
  return anyRes ? JOB_STATES.INVENTORY_ASSIGNED : JOB_STATES.WAITING_FOR_INVENTORY;
}
/* Derived current warehouse step. */
function currentWarehouseStep(wo) {
  var r = jobReadiness(wo);
  if (r === JOB_STATES.COMPLETED) return 'COMPLETE';
  if (r === JOB_STATES.ON_HOLD || r === JOB_STATES.CANCELLED) return 'WAITING';
  if (r === JOB_STATES.READY_FOR_NEXT_STEP) return 'CYCLE COUNT REVIEW';
  var lines = wo.lines || [];
  var acts = [];
  lines.forEach(function (l) {
    allAssignmentsForLine(wo.id, l.id).forEach(function (a) {
      if (a.status === AI_STATUS.RESERVED) acts.push(a);
    });
  });
  if (woCuts(wo).length) return 'CUT MATERIAL';
  if (acts.length) {
    var unverified = acts.some(function (a) { return !a.rollVerifiedAt; });
    return unverified ? 'VERIFY ROLL' : 'CUT MATERIAL';
  }
  return 'ASSIGN INVENTORY';
}
/* Inventory readiness summary for cards (spec section 20). */
function inventoryReadiness(wo) {
  var lines = wo.lines || [];
  if (!lines.length) return 'NOT ASSIGNED';
  var parts = [];
  var allDone = true, anyRes = false;
  lines.forEach(function (l) {
    var act = activeAssignments(wo.id, l.id);
    var st = lineStatus(wo, l);
    if (st === 'COMPLETED') {
      parts.push({ line: l, text: 'COMPLETE', cls: 'st-green' });
    } else if (act.length) {
      anyRes = true;
      if (act.length === 1 && act[0].rollId) {
        var roll = rollById(act[0].rollId);
        var loc = (roll && roll.expectedLocation) || act[0].location || '';
        parts.push({ line: l, text: 'ROLL ' + act[0].rollId + (loc ? ' · ' + loc : ''), cls: 'st-blue',
                     rollId: act[0].rollId, assignId: act[0].id });
      } else {
        parts.push({ line: l, text: 'RESERVED ×' + act.length, cls: 'st-blue' });
      }
      if (st !== 'ASSIGNED') allDone = false;
    } else {
      allDone = false;
      parts.push({ line: l, text: 'NOT ASSIGNED', cls: 'st-yellow' });
    }
  });
  return parts.length === 1 && parts[0].text === 'NOT ASSIGNED' && !anyRes
    ? 'NOT ASSIGNED'
    : { parts: parts, partial: !allDone && anyRes, complete: allDone };
}
/* Cut status: CUT REQUIRED / CUT IN PROGRESS / CUT COMPLETE (+ actual). */
function woCutStatus(wo) {
  var lines = wo.lines || [];
  var cuts = woCuts(wo);
  var cutIn = cuts.reduce(function (s, c) { return s + (c.inches || 0); }, 0);
  var doneLines = lines.filter(function (l) { return lineStatus(wo, l) === 'COMPLETED'; }).length;
  if (lines.length && doneLines === lines.length && cuts.length)
    return { state: 'CUT COMPLETE', cutIn: cutIn, cuts: cuts };
  if (cuts.length) return { state: 'CUT IN PROGRESS', cutIn: cutIn, cuts: cuts };
  return { state: 'CUT REQUIRED', cutIn: 0, cuts: [] };
}
/* The single most relevant next action for a job card. */
function jobQuickAction(wo) {
  var r = jobReadiness(wo);
  if (r === JOB_STATES.WAITING_FOR_INVENTORY || r === JOB_STATES.INVENTORY_ASSIGNED)
    return { label: 'ASSIGN INVENTORY', route: 'assign-inventory/wo/' + wo.id };
  if (r === JOB_STATES.READY_TO_CUT) {
    var acts = [];
    (wo.lines || []).forEach(function (l) {
      allAssignmentsForLine(wo.id, l.id).forEach(function (a) {
        if (a.status === AI_STATUS.RESERVED) acts.push(a);
      });
    });
    var route = acts.length === 1 ? 'assign-inventory/a/' + acts[0].id : 'assign-inventory/wo/' + wo.id;
    return { label: 'CONTINUE TO CUT', route: route };
  }
  if (r === JOB_STATES.IN_PROGRESS) return { label: 'CONTINUE WORK', route: 'scheduled-job/' + wo.id };
  if (r === JOB_STATES.CUT_COMPLETE || r === JOB_STATES.READY_FOR_NEXT_STEP)
    return { label: 'VIEW WORK ORDER', route: 'scheduled-job/' + wo.id };
  if (r === JOB_STATES.COMPLETED) return { label: 'VIEW COMPLETED JOB', route: 'work-order/' + wo.id };
  return { label: 'VIEW WORK ORDER', route: 'scheduled-job/' + wo.id };
}
/* Jobs for the queue: work orders that belong on the schedule. A work
   order is a scheduled job when it has a scheduled date, is in progress,
   is on hold, or completed recently. Unscheduled OPEN orders stay in the
   Work Orders module only. */
function isScheduledJob(wo) {
  if (!wo) return false;
  if (wo.scheduledDate) return true;
  if (wo.onHold) return true;
  if (wo.opStatus === 'IN_PROGRESS') return true;
  if (wo.opStatus === 'COMPLETE' || wo.warehouseCompletedAt) return true;
  return false;
}
function scheduledJobs() {
  return (FG().workOrders || []).filter(isScheduledJob);
}
function jobsForDate(ds) {
  return scheduledJobs().filter(function (w) { return w.scheduledDate === ds; });
}
function myScheduledJobs() {
  var eid = currentAssigneeId();
  return scheduledJobs().filter(function (w) { return w.assigneeId && w.assigneeId === eid; });
}
function unassignedJobs() {
  return scheduledJobs().filter(function (w) { return !w.assigneeId; });
}
/* Dashboard counts (spec section 32). */
function scheduledJobCounts() {
  var today = warehouseToday();
  var jobs = scheduledJobs();
  var counts = { today: 0, inProgress: 0, waitingForInventory: 0, completedToday: 0 };
  jobs.forEach(function (w) {
    var r = jobReadiness(w);
    if (w.scheduledDate === today) counts.today++;
    if (r === JOB_STATES.IN_PROGRESS) counts.inProgress++;
    if (r === JOB_STATES.WAITING_FOR_INVENTORY) counts.waitingForInventory++;
    if (r === JOB_STATES.COMPLETED && w.warehouseCompletedAt && isToday(w.warehouseCompletedAt))
      counts.completedToday++;
  });
  return counts;
}
/* ---- scheduled-job mutations (local; wrapped by Repository for shared) ---- */
function setJobHoldLocal(woId, reason) {
  var w = woById(woId);
  if (!w) return { ok: false, err: 'WORK ORDER NOT FOUND' };
  if (!isSupervisorRole(DB.data.currentEmployee))
    return { ok: false, err: 'SUPERVISOR ROLE REQUIRED' };
  if (w.onHold) return { ok: false, err: 'ALREADY ON HOLD' };
  w.onHold = true; w.holdReason = reason || 'OTHER'; w.holdAt = new Date().toISOString();
  w.holdBy = DB.data.currentEmployee;
  DB.save();
  logAssignEvent('JOB_HELD', { workOrderId: w.id, detail: 'Job placed ON HOLD: ' + w.holdReason });
  return { ok: true, workOrder: w };
}
function resumeJobLocal(woId) {
  var w = woById(woId);
  if (!w) return { ok: false, err: 'WORK ORDER NOT FOUND' };
  if (!isSupervisorRole(DB.data.currentEmployee))
    return { ok: false, err: 'SUPERVISOR ROLE REQUIRED' };
  if (!w.onHold) return { ok: false, err: 'NOT ON HOLD' };
  w.onHold = false; w.holdReason = null; w.holdAt = null; w.holdBy = null;
  DB.save();
  logAssignEvent('JOB_RESUMED', { workOrderId: w.id, detail: 'Job resumed from hold.' });
  return { ok: true, workOrder: w };
}
function startWarehouseWorkLocal(woId) {
  var w = woById(woId);
  if (!w) return { ok: false, err: 'WORK ORDER NOT FOUND' };
  if (w.onHold) return { ok: false, err: 'JOB IS ON HOLD' };
  if (w.opStatus !== 'IN_PROGRESS') {
    w.opStatus = 'IN_PROGRESS';
    w.startedAt = w.startedAt || new Date().toISOString();
    w.startedBy = w.startedBy || DB.data.currentEmployee;
    DB.save();
    logAssignEvent('WAREHOUSE_WORK_STARTED', { workOrderId: w.id, detail: 'Warehouse work started.' });
  }
  return { ok: true, workOrder: w };
}
function assignEmployeeLocal(woId, assigneeId) {
  var w = woById(woId);
  if (!w) return { ok: false, err: 'WORK ORDER NOT FOUND' };
  w.assigneeId = assigneeId || null;
  DB.save();
  var nm = woAssigneeName(w);
  logAssignEvent('EMPLOYEE_ASSIGNED', { workOrderId: w.id,
    detail: nm ? 'Assigned to ' + nm + '.' : 'Unassigned.' });
  return { ok: true, workOrder: w };
}
/* Run 6 §0: the assigned warehouse employee may complete their own job. */
function isWoAssignee(w) {
  if (!w || !w.assigneeId || !DB.data) return false;
  var cur = DB.data.currentEmployee;
  if (woAssigneeName(w) === cur) return true;
  return w.assigneeId === currentAssigneeId();
}
/* Guard: every material line must be COMPLETED before warehouse completion.
   Run 6: count-based lines (PLANK/BOX/…) have no cut-based assignment engine
   yet, so no automatic rule can verify them — completion is supervisor /
   manager judgment and is recorded in the audit trail. The UI surfaces
   them explicitly so nobody mistakes silence for verification. */
function warehouseCompletionBlockers(wo) {
  var blockers = [];
  (wo.lines || []).forEach(function (l) {
    if (l.requiredCount != null) return;
    var st = lineStatus(wo, l);
    if (st !== 'COMPLETED') blockers.push({ lineId: l.id, line: l, status: st });
  });
  return blockers;
}
function woCountBasedLines(wo) {
  return ((wo && wo.lines) || []).filter(function (l) { return l.requiredCount != null; });
}
function completeWarehouseWorkLocal(woId) {
  var w = woById(woId);
  if (!w) return { ok: false, err: 'WORK ORDER NOT FOUND' };
  /* Run 6 §0: the assigned employee may complete their own job; supervisor /
     manager / admin may complete any job. Line-completion guard is never
     bypassed. */
  if (!isSupervisorRole(DB.data.currentEmployee) && !isWoAssignee(w))
    return { ok: false, err: 'NOT AUTHORIZED TO COMPLETE THIS JOB' };
  if (w.onHold) return { ok: false, err: 'JOB IS ON HOLD' };
  /* Run 6: count-based lines (BOX/EA/…) have no cut-based verification
     engine, so a plain assignee cannot self-certify them — a supervisor /
     manager / admin sign-off is required and is recorded in the audit
     trail below. */
  var countLines = woCountBasedLines(w);
  var isSup = isSupervisorRole(DB.data.currentEmployee);
  if (!isSup && countLines.length)
    return { ok: false, err: 'COUNT-BASED LINES REQUIRE SUPERVISOR VERIFICATION' };
  var blockers = warehouseCompletionBlockers(w);
  if (blockers.length) return { ok: false, err: 'MATERIAL LINES INCOMPLETE', blockers: blockers };
  w.opStatus = 'COMPLETE';
  w.warehouseCompletedAt = new Date().toISOString();
  w.warehouseCompletedBy = DB.data.currentEmployee;
  DB.save();
  logAssignEvent('WAREHOUSE_WORK_COMPLETED', { workOrderId: w.id,
    detail: 'Warehouse work completed by ' + DB.data.currentEmployee + '.' +
      (countLines.length ? ' (' + countLines.length + ' count-based line(s) accepted under supervisor judgment.)' : '') });
  return { ok: true, workOrder: w };
}
/* Run 6 §0: authorized supervisor/manager roles may reopen a completed
   warehouse job for later correction. Requires an audit reason. The job
   returns to IN_PROGRESS; completion fields are cleared. */
function reopenWarehouseWorkLocal(woId, reason) {
  var w = woById(woId);
  if (!w) return { ok: false, err: 'WORK ORDER NOT FOUND' };
  if (!isSupervisorRole(DB.data.currentEmployee))
    return { ok: false, err: 'SUPERVISOR ROLE REQUIRED' };
  reason = String(reason || '').trim();
  if (!reason) return { ok: false, err: 'REASON REQUIRED' };
  if (w.opStatus !== 'COMPLETE') return { ok: false, err: 'JOB IS NOT COMPLETED' };
  w.opStatus = 'IN_PROGRESS';
  w.warehouseCompletedAt = null;
  w.warehouseCompletedBy = null;
  DB.save();
  logAssignEvent('WAREHOUSE_WORK_REOPENED', { workOrderId: w.id,
    detail: 'Warehouse job reopened by ' + DB.data.currentEmployee + ': ' + reason });
  return { ok: true, workOrder: w };
}
/* Notes are append-only audit events — never overwritten. */
function addWorkOrderNoteLocal(woId, text) {
  var w = woById(woId);
  if (!w) return { ok: false, err: 'WORK ORDER NOT FOUND' };
  text = String(text || '').trim();
  if (!text) return { ok: false, err: 'NOTE IS EMPTY' };
  logAssignEvent('WORK_ORDER_NOTE_ADDED', { workOrderId: w.id, detail: text });
  return { ok: true };
}
function woNotes(wo) {
  return assignEventsForWO(wo.id).filter(function (e) { return e.action === 'WORK_ORDER_NOTE_ADDED'; });
}

/* Append-only audit record for every assignment action. */
function logAssignEvent(action, o) {  o = o || {};
  var now = new Date().toISOString();
  FG().assignmentEvents.push({
    id: aeSeq(), at: now,
    action: action, user: o.user || DB.data.currentEmployee,
    warehouse: o.warehouse || DB.data.currentWarehouse,
    workOrderId: o.workOrderId || null, lineId: o.lineId || null,
    rollId: o.rollId || null,
    assignmentId: o.assignmentId || null, detail: o.detail || ''
  });
  DB.save();
}
function assignEventsForWO(woId) {
  return (FG().assignmentEvents || []).filter(function (e) { return e.workOrderId === woId; })
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
}
/* The reservation itself. Role rules:
   - MATCH + within balance: any signed-in employee may assign.
   - MISMATCH / INCOMPLETE material data: supervisor approval required.
   - OVER-RESERVED: supervisor approval required.
   - Unknown balance (discovered, never measured): supervisor approval. */
/* Validation shared by local mode and SharedFlow (shared mode): the same
   business rules — compatibility, supervisor gates, over-reservation —
   apply no matter which provider persists the reservation. */
function validateAssignInput(o) {
  var wo = woById(o.woId);
  if (!wo) return { ok: false, err: 'WORK ORDER NOT FOUND' };
  var line = lineById(wo, o.lineId);
  if (!line) return { ok: false, err: 'MATERIAL LINE NOT FOUND' };
  var roll = assignableRoll(o.rollId);
  if (!roll) return { ok: false, err: 'ROLL NOT FOUND' };
  var employee = o.employee || DB.data.currentEmployee;
  if (!employee) return { ok: false, err: 'SIGN IN FIRST' };
  var reservedIn = Math.round(Number(o.reservedIn) || 0);
  if (reservedIn <= 0) return { ok: false, err: 'RESERVED QUANTITY MUST BE GREATER THAN ZERO' };
  var compat = checkCompatibility(roll, line);
  var bal = assignableBalance(roll);
  var ov = overReserved(roll.id, reservedIn);
  var mismatchBy = o.mismatchApprovedBy || null;
  var overBy = o.overApprovedBy || null;
  if ((compat.verdict === 'MISMATCH' || compat.verdict === 'INCOMPLETE') &&
      !(mismatchBy && isSupervisorRole(mismatchBy)))
    return { ok: false, err: 'MATERIAL ' + compat.verdict + ' — SUPERVISOR APPROVAL REQUIRED', compat: compat };
  if (ov.unknown && !(mismatchBy && isSupervisorRole(mismatchBy)))
    return { ok: false, err: 'BALANCE UNKNOWN — SUPERVISOR APPROVAL REQUIRED' };
  if (ov.over && !(overBy && isSupervisorRole(overBy)))
    return { ok: false, err: 'OVER-RESERVED — SUPERVISOR APPROVAL REQUIRED', over: ov };
  return {
    ok: true, wo: wo, line: line, roll: roll, employee: employee,
    reservedIn: reservedIn, compat: compat, bal: bal, over: ov,
    mismatchBy: mismatchBy, overBy: overBy, discoveredRoll: isDiscoveredRoll(roll)
  };
}
function assignInventory(o) {
  var v = validateAssignInput(o);
  if (!v.ok) return v;
  var wo = v.wo, line = v.line, roll = v.roll, employee = v.employee,
      reservedIn = v.reservedIn, compat = v.compat, ov = v.over,
      mismatchBy = v.mismatchBy, overBy = v.overBy;
  var now = new Date().toISOString();
  var rec = {
    id: aiSeq(), workOrderId: wo.id, lineId: line.id, rollId: roll.id,
    discovered: isDiscoveredRoll(roll),
    requiredIn: line.requiredIn, reservedIn: reservedIn,
    employee: employee, warehouseId: DB.data.currentWarehouse,
    location: roll.expectedLocation || roll.lastLocation || '',
    at: now, status: AI_STATUS.RESERVED,
    mismatchApprovedBy: mismatchBy, overApprovedBy: overBy,
    rollVerifiedAt: null, rollVerifiedBy: null,
    locationVerifiedAt: null, locationVerifiedBy: null,
    releasedAt: null, releasedBy: null,
    consumedAt: null, consumedBy: null, cutId: null, actualCutIn: null
  };
  FG().inventoryAssignments.push(rec);
  logAssignEvent('INVENTORY_ASSIGNED', {
    user: employee, workOrderId: wo.id, lineId: line.id, rollId: roll.id, assignmentId: rec.id,
    detail: 'Roll ' + roll.id + ' → ' + wo.number + ' line ' + line.id +
      ', reserved ' + fmtLen(reservedIn) + (mismatchBy ? ' (material override: ' + mismatchBy + ')' : '') +
      (overBy ? ' (over-reservation: ' + overBy + ')' : '')
  });
  if (mismatchBy) logAssignEvent('MATERIAL_MISMATCH_OVERRIDE', {
    user: mismatchBy, workOrderId: wo.id, lineId: line.id, rollId: roll.id, assignmentId: rec.id,
    detail: 'Approved ' + compat.verdict + ': ' +
      compat.mismatches.map(function (m) { return m.field + ' roll=' + m.roll + ' line=' + m.line; }).join(', ')
  });
  if (overBy) logAssignEvent('OVER_RESERVATION_APPROVED', {
    user: overBy, workOrderId: wo.id, lineId: line.id, rollId: roll.id, assignmentId: rec.id,
    detail: 'Total reserved ' + fmtLen(ov.total) + ' vs balance ' + fmtLen(ov.balance)
  });
  if (wo.opStatus === 'OPEN') wo.opStatus = 'IN_PROGRESS';
  DB.save();
  return { ok: true, rec: rec, compat: compat, over: ov };
}
/* Release before any cut: status -> RELEASED, record kept forever. */
function releaseAssignment(assignId, by) {
  var rec = (FG().inventoryAssignments || []).filter(function (a) { return a.id === assignId; })[0];
  if (!rec) return { ok: false, err: 'ASSIGNMENT NOT FOUND' };
  if (rec.status !== AI_STATUS.RESERVED) return { ok: false, err: 'ONLY ACTIVE RESERVATIONS CAN BE RELEASED' };
  var who = by || DB.data.currentEmployee;
  if (!isSupervisorRole(who) && rec.employee !== who)
    return { ok: false, err: 'ONLY A SUPERVISOR OR THE ASSIGNING EMPLOYEE MAY RELEASE' };
  rec.status = AI_STATUS.RELEASED;
  rec.releasedAt = new Date().toISOString();
  rec.releasedBy = who;
  logAssignEvent('INVENTORY_RELEASED', {
    user: who, workOrderId: rec.workOrderId, lineId: rec.lineId,
    rollId: rec.rollId, assignmentId: rec.id,
    detail: 'Released ' + fmtLen(rec.reservedIn) + ' reservation'
  });
  DB.save();
  return { ok: true, rec: rec };
}
/* A recorded cut consumes the reservation it was assigned for. */
function consumeAssignment(assignId, o) {
  var rec = (FG().inventoryAssignments || []).filter(function (a) { return a.id === assignId; })[0];
  if (!rec) return { ok: false, err: 'ASSIGNMENT NOT FOUND' };
  if (rec.status !== AI_STATUS.RESERVED) return { ok: false, err: 'ONLY ACTIVE RESERVATIONS CAN BE CONSUMED' };
  rec.status = AI_STATUS.CONSUMED;
  rec.consumedAt = new Date().toISOString();
  rec.consumedBy = o.by || DB.data.currentEmployee;
  rec.cutId = o.cutId || null;
  rec.actualCutIn = (o.actualCutIn != null) ? Math.round(o.actualCutIn) : null;
  logAssignEvent('ASSIGNMENT_CONSUMED', {
    user: rec.consumedBy, workOrderId: rec.workOrderId, lineId: rec.lineId,
    rollId: rec.rollId, assignmentId: rec.id,
    detail: 'Cut ' + fmtLen(rec.actualCutIn || 0) + (rec.cutId ? ' (' + rec.cutId + ')' : '')
  });
  DB.save();
  return { ok: true, rec: rec };
}
/* ---------------- Run 4: data provider dispatch ----------------
   In LOCAL DEMO mode these resolve through the synchronous local
   functions above (zero behavior change). In SHARED PILOT mode they go
   through SharedFlow: validate locally -> atomic backend RPC -> apply the
   authoritative result to the in-memory store. Always returns a Promise. */
function dataMode() {
  return (typeof Repository !== 'undefined' && Repository.mode) || 'local';
}
function assignInventoryAsync(o) {
  if (dataMode() === 'shared' && typeof SharedFlow !== 'undefined') return SharedFlow.assignInventory(o);
  return Promise.resolve(assignInventory(o));
}
function releaseAssignmentAsync(assignId, by) {
  if (dataMode() === 'shared' && typeof SharedFlow !== 'undefined') return SharedFlow.releaseAssignment(assignId, by);
  return Promise.resolve(releaseAssignment(assignId, by));
}
function recordCutAsync(opts) {
  if (dataMode() === 'shared' && typeof SharedFlow !== 'undefined') return SharedFlow.recordCut(opts);
  return Promise.resolve(CutService.recordCut(opts));
}
/* Sync-indicator DOM hook (repository.js Sync -> topbar dot). Safe to call
   when repository.js is not loaded (Run 1-3 tests): it no-ops. */
function updateSyncIndicator() {
  var el = document.getElementById('sync');
  if (!el) return;
  var s = (typeof Sync !== 'undefined') ? Sync.state : 'SYNCED';
  var mode = dataMode();
  el.className = 'sync s-' + s.toLowerCase().replace('_', '-');
  el.title = (mode === 'shared' ? 'Shared Pilot' : 'Local Demo') + ' · ' +
    ({ SYNCED: 'Synced', SYNCING: 'Syncing…', OFFLINE: 'Offline — changes stay on this device', 'SYNC_ERROR': 'Sync error — tap Settings to retry' }[s] || s);
}
if (typeof Sync !== 'undefined' && Sync.onChange) {
  Sync.onChange(function () { updateSyncIndicator(); });
}
/* DISCOVER ROLL inside the assign flow: same discovered-roll record the
   Free Run flow creates — one shared architecture, no second database. */
function discoverRollForAssign(code, o) {
  o = o || {};
  var norm = normalizeBarcode(code);
  if (!norm) return { ok: false, err: 'EMPTY CODE' };
  var existing = rollByBarcode(norm) || findDiscovered(norm);
  if (existing) return { ok: true, roll: existing, already: true };
  var meas = (o.measuredIn != null) ? Math.round(o.measuredIn) : null;
  var d = {
    id: norm, raw: String(code || ''), firstSeenAt: new Date().toISOString(),
    firstSeenBy: o.employee || DB.data.currentEmployee,
    lastLocation: o.location ? normLoc(o.location) : '',
    lastMeasuredIn: meas, lastMeasuredAt: meas != null ? new Date().toISOString() : null,
    lastMeasuredBy: meas != null ? (o.employee || DB.data.currentEmployee) : null,
    count: 1, source: 'ASSIGN_INVENTORY'
  };
  FG().discovered.push(d);
  DB.save();
  return { ok: true, roll: d, already: false };
}



/* ---------------- navigation structure ----------------
   Single source of truth for the drawer, dashboard tiles,
   and route titles. Run N adds an item here + a Screens entry. */
var NAV = [
  { group: 'DASHBOARD', items: [
    { route: 'dashboard', label: 'Dashboard', icon: '🏠' }
  ] },
  { group: 'WAREHOUSE', items: [
    { route: 'work-orders',       label: 'Work Orders',       icon: '🧾' },
    { route: 'sales-orders',      label: 'Sales Orders',      icon: '📦' },
    { route: 'assign-inventory',  label: 'Assign Inventory',  icon: '🗂️' },
    { route: 'cut-roll-tracking', label: 'Cut / Roll Tracking', icon: '✂️' },
    { route: 'cycle-count',       label: 'Cycle Count',       icon: '🔄' },
    { route: 'balance',           label: 'Balance',           icon: '⚖️' },
    { route: 'history',           label: 'History',           icon: '📜' }
  ] },
  { group: 'OPERATIONS', items: [
    { route: 'scheduled-jobs', label: 'Scheduled Jobs',    icon: '🗓️' },
    { route: 'returns',        label: 'Returns',           icon: '↩️' },
    { route: 'qa-warranty',    label: 'QA Request / Warranty', icon: '🛡️' },
    { route: 'reports',        label: 'Reports',           icon: '📊' }
  ] },
  { group: 'BUSINESS', items: [
    { route: 'near-me',  label: 'Near Me',  icon: '📍' },
    { route: 'order',    label: 'Order',    icon: '🛒' },
    { route: 'account',  label: 'Account',  icon: '👤' },
    { route: 'pricing',  label: 'Pricing',  icon: '💲' },
    { route: 'gallery',  label: 'Gallery',  icon: '🖼️' },
    { route: 'contact',  label: 'Contact',  icon: '📞' }
  ] },
  { group: 'SYSTEM', items: [
    { route: 'settings',  label: 'Settings', icon: '⚙️' },
    { route: '__logout',  label: 'Logout',   icon: '🚪' }
  ] }
];

/* What each future module will contain. Shown on the Run 1
   placeholder screens so the roadmap is visible in the app. */
var MODULE_INFO = {
  'work-orders':       { icon: '🧾', title: 'Work Orders',
    points: ['Work order queue and status', 'Assign work to the team', 'Track progress through the shift'] },
  'sales-orders':      { icon: '📦', title: 'Sales Orders',
    points: ['Sales order list', 'Order details and line items', 'Fulfillment status'] },
  'assign-inventory':  { icon: '🗂️', title: 'Assign Inventory',
    points: ['Work order -> material line -> roll reservation', 'Material match / mismatch checks', 'Over-reservation guard', 'Reservation lifecycle: RESERVED / RELEASED / CONSUMED'] },
  'cut-roll-tracking': { icon: '✂️', title: 'Cut / Roll Tracking',
    points: ['Scan Roll', 'Current Balance', 'Work Order', 'Cut amount', 'Permanent cut history per roll'] },
  'cycle-count':       { icon: '🔄', title: 'Cycle Count',
    points: ['Standard Cycle Count', 'Free Run / Discovery Mode', 'Rapid Cycle Count',
             'Location scanning', 'Roll scanning', 'Measured Balance',
             'History Card Capture', 'Discrepancy Review'] },
  'balance':           { icon: '⚖️', title: 'Balance',
    points: ['Roll balances at a glance', 'Expected vs measured comparison', 'Balance history'] },
  'history':           { icon: '📜', title: 'History',
    points: ['Roll history timeline', 'History-card documents', 'Audit trail'] },
  'scheduled-jobs':    { icon: '🗓️', title: 'Scheduled Jobs',
    points: ['Daily warehouse queue: today / upcoming / in progress / completed', 'Derived job readiness — never stored', 'One-tap next actions: assign, cut, complete'] },
  'returns':           { icon: '↩️', title: 'Returns',
    points: ['Return requests', 'Inspection flow', 'Return disposition'] },
  'qa-warranty':       { icon: '🛡️', title: 'QA Request / Warranty',
    points: ['QA requests', 'Warranty claims', 'Claim status tracking'] },
  'reports':           { icon: '📊', title: 'Reports',
    points: ['Supervisor reports', 'Count and cut summaries', 'CSV / PDF exports'] },
  'near-me':           { icon: '📍', title: 'Near Me',
    points: ['Nearby warehouses and stores', 'Directions and contact'] },
  'order':             { icon: '🛒', title: 'Order',
    points: ['Place a material order', 'Order status'] },
  'account':           { icon: '👤', title: 'Account',
    points: ['Account details', 'Company profile'] },
  'pricing':           { icon: '💲', title: 'Pricing',
    points: ['Price lists', 'Product pricing'] },
  'gallery':           { icon: '🖼️', title: 'Gallery',
    points: ['Product gallery', 'Material photos'] },
  'contact':           { icon: '📞', title: 'Contact',
    points: ['Contact information', 'Support'] },
  'settings':          { icon: '⚙️', title: 'Settings', points: [] }
};

function navLabel(route) {
  for (var g = 0; g < NAV.length; g++) {
    var items = NAV[g].items;
    for (var i = 0; i < items.length; i++) {
      if (items[i].route === route) return items[i].label;
    }
  }
  return 'FloorGuard Ops';
}

/* ---------------- slide-out drawer ---------------- */
function drawerHtml() {
  var html = '';
  NAV.forEach(function (g) {
    html += '<div class="dgroup"><div class="dgroup-label">' + esc(g.group) + '</div>';
    g.items.forEach(function (it) {
      html += '<button class="ditem" data-route="' + esc(it.route) + '">' +
              '<span class="dicon">' + it.icon + '</span>' +
              '<span class="dlabel">' + esc(it.label) + '</span></button>';
    });
    html += '</div>';
  });
  return html;
}

function renderDrawer() {
  var nav = $('#drawer-nav');
  nav.innerHTML = drawerHtml();
  var btns = nav.querySelectorAll('.ditem');
  for (var i = 0; i < btns.length; i++) {
    (function (b) {
      b.onclick = function () {
        var r = b.getAttribute('data-route');
        if (r === '__logout') { doLogout(); return; }
        closeDrawer();
        go(r);
      };
    })(btns[i]);
  }
}

function openDrawer() {
  $('#drawer').classList.add('open');
  var scrim = $('#scrim');
  scrim.hidden = false;
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').hidden = true;
}
function markActiveNav(route) {
  var nav = $('#drawer-nav');
  if (!nav || !nav.querySelectorAll) return;
  var btns = nav.querySelectorAll('.ditem');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    if (b.getAttribute('data-route') === route) b.classList.add('active');
    else b.classList.remove('active');
  }
}

/* ---------------- session ----------------
   Session = the signed-in employee, persisted in DB.
   Every route except sign-in requires a session. */
function needsSignin() { return !DB.data.currentEmployee; }

function setEmployee(name) {
  name = String(name || '').trim();
  if (!name) return;
  if (DB.data.employees.indexOf(name) < 0) DB.data.employees.push(name);
  DB.data.currentEmployee = name;
  DB.save();
  toast('Signed in as ' + name);
  go('dashboard');
}

function doLogout() {
  DB.data.currentEmployee = null;
  DB.save();
  closeDrawer();
  go('signin');
}

/* ---------------- router ---------------- */
function parseHash() {
  var h = (typeof window !== 'undefined' && window.location && window.location.hash) || '';
  var m = h.match(/^#\/(.+)$/);
  return m ? m[1] : 'dashboard';
}
/* Longest-prefix match of a hash path against registered screen keys, so
   param routes like 'roll/QH5CPHN' resolve to the 'roll' screen. */
function matchRoute(path) {
  var keys = Object.keys(Screens).sort(function (a, b) { return b.length - a.length; });
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (path === k) return k;
    /* Query-string entry, e.g. assign-inventory?workOrder=XS024536. */
    if (path.indexOf(k + '?') === 0) return k;
    if (path.indexOf(k + '/') === 0) return k;
  }
  return null;
}
function routeParam(path, name) {
  if (path === name) return '';
  if (path.indexOf(name + '/') === 0) return decodeURIComponent(path.slice(name.length + 1));
  return '';
}
function go(route, param) {
  window.location.hash = '#/' + route + (param ? '/' + encodeURIComponent(param) : '');
}
function resolveRoute(r) {
  if (r === 'signin') return 'signin';
  if (needsSignin()) return 'signin';
  var hit = matchRoute(r);
  if (hit) return hit;
  return 'dashboard';
}
function updateTopbar(route) {
  document.body.classList.toggle('nosession', needsSignin());
  var chip = $('#empchip');
  var emp = DB.data.currentEmployee || '';
  var role = emp && DB.data.employeeRoles ? DB.data.employeeRoles[emp] : '';
  chip.textContent = emp + (role ? ' · ' + role : '');
  var wh = (DB.data.warehouses || []).filter(function (w) { return w.id === DB.data.currentWarehouse; })[0];
  var title = $('#tb-title');
  title.innerHTML = 'FLOORGUARD <span class="ops">OPS</span>' +
    (wh ? ' <span class="wh">' + esc(wh.name) + '</span>' : '');
  updateConn();
}
/* Connection indicator: online/offline state for the tablet. */
function updateConn() {
  var el = $('#conn');
  if (!el) return;
  var online = (typeof navigator === 'undefined') ? true : navigator.onLine !== false;
  el.classList.toggle('off', !online);
  el.title = online ? 'Online' : 'Offline — changes are saved on this device';
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', updateConn);
  window.addEventListener('offline', updateConn);
}
function render() {
  closeDrawer();
  /* Never leave the camera running between screens. */
  if (typeof Scanner !== 'undefined' && Scanner.stop) Scanner.stop();
  var path = parseHash();
  var r = resolveRoute(path);
  var param = routeParam(path, r);
  var s = Screens[r](param);
  $('#view').innerHTML = s.html;
  updateTopbar(r);
  markActiveNav(r);
  updateSyncIndicator();
  if (s.mount) s.mount();
  if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
}

/* ---------------- shared components ---------------- */
function pageHead(title, sub) {
  return '<div class="step-head"><h1>' + title + '</h1>' +
         (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
}

function toast(msg) {
  var old = document.getElementById('toast');
  if (old) old.remove();
  var t = document.createElement('div');
  t.id = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function () { var x = document.getElementById('toast'); if (x) x.remove(); }, 2200);
}

/* In-app confirm modal (never the native confirm()).
   Returns a Promise<boolean>; opts.onOk is still called for legacy callers. */
function showConfirm(opts) {
  return new Promise(function (resolve) {
    var wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
      '<h2>' + esc(opts.title || 'Are you sure?') + '</h2>' +
      '<p>' + esc(opts.body || '') + '</p>' +
      '<button class="btn btn-primary" id="mc-ok">' + esc(opts.okLabel || 'CONFIRM') + '</button>' +
      '<button class="btn" id="mc-cancel">' + esc(opts.cancelLabel || 'CANCEL') + '</button>' +
      '</div>';
    document.body.appendChild(wrap);
    function close(v) { wrap.remove(); resolve(v); }
    wrap.querySelector('#mc-ok').onclick = function () { close(true); if (opts.onOk) opts.onOk(); };
    wrap.querySelector('#mc-cancel').onclick = function () { close(false); };
    wrap.onclick = function (e) { if (e.target === wrap) close(false); };
  });
}

/* Placeholder screen for modules arriving in later runs. */
function moduleScreen(key) {
  var info = MODULE_INFO[key];
  var points = info.points.map(function (p) {
    return '<div class="pli"><span class="pdot">▸</span><span>' + esc(p) + '</span></div>';
  }).join('');
  return {
    html:
      '<div class="screen">' +
      pageHead(info.icon + ' ' + esc(info.title), 'Warehouse module') +
      '<div class="card placeholder">' +
      '<div class="ph-icon">' + info.icon + '</div>' +
      '<div class="ph-title">' + esc(info.title) + '</div>' +
      '<div class="ph-sub">Arriving in a later run. The foundation is ready — ' +
      'this module&rsquo;s data area <span class="mono">modules.' + esc(key) + '</span> is reserved.</div>' +
      '<div class="ph-list">' + points + '</div>' +
      '</div>' +
      '<button class="btn" id="ph-back">← DASHBOARD</button>' +
      '</div>',
    mount: function () {
      $('#ph-back').onclick = function () { go('dashboard'); };
    }
  };
}

/* ---------------- screens ---------------- */
var Screens = {};

Screens.signin = function () {
  var switching = !!DB.data.currentEmployee;
  var btns = DB.data.employees.map(function (e) {
    var initial = esc(e.trim().charAt(0).toUpperCase() || '?');
    return '<button class="btn empbtn" data-emp="' + esc(e) + '">' +
           '<span class="avatar">' + initial + '</span>' +
           '<span>' + esc(e) + '</span></button>';
  }).join('');
  return {
    html:
      '<div class="screen" style="max-width:560px">' +
      '<div class="signin-hero">' +
      '<div class="brand">FLOORGUARD <span class="ops">OPS</span></div>' +
      '<div class="tag">Warehouse Operations Platform</div>' +
      '</div>' +
      pageHead(switching ? 'Switch employee' : 'Who is working?', switching ? '' : 'Tap your name to sign in.') +
      '<div id="s-empbtns">' + btns + '</div>' +
      '<div class="sect">NEW EMPLOYEE</div>' +
      '<form id="s-addform">' +
      '<label class="f" for="s-newname">Name</label>' +
      '<input type="text" id="s-newname" autocomplete="off" placeholder="e.g. Marcus">' +
      '<button class="btn btn-primary" type="submit">ADD &amp; SIGN IN</button>' +
      '</form>' +
      '</div>',
    mount: function () {
      var list = document.querySelectorAll('#s-empbtns .empbtn');
      for (var i = 0; i < list.length; i++) {
        (function (b) {
          b.onclick = function () { setEmployee(b.getAttribute('data-emp')); };
        })(list[i]);
      }
      $('#s-addform').onsubmit = function (e) {
        e.preventDefault();
        var v = $('#s-newname').value;
        if (v && v.trim()) setEmployee(v);
      };
    }
  };
};

Screens.dashboard = function () {
  function tiles(keys) {
    return '<div class="tiles">' + keys.map(function (k) {
      var info = MODULE_INFO[k];
      return '<button class="tile" data-route="' + esc(k) + '">' +
             '<span class="ticon">' + info.icon + '</span>' +
             '<span>' + esc(info.title) + '</span></button>';
    }).join('') + '</div>';
  }
  var wh = ['work-orders', 'sales-orders', 'assign-inventory', 'cut-roll-tracking',
            'cycle-count', 'balance', 'history'];
  var ops = ['scheduled-jobs', 'returns', 'qa-warranty', 'reports'];
  /* Run 5: dashboard queue cards from scheduled-job data. */
  var qc = scheduledJobCounts();
  function qcard(n, label, tab, filter) {
    var dest = 'scheduled-jobs/' + tab + (filter ? '/' + filter : '');
    return '<button class="qcard" data-qroute="' + esc(dest) + '">' +
      '<span class="qnum">' + n + '</span><span class="qlabel">' + esc(label) + '</span></button>';
  }
  var queueHtml =
    '<div class="sect">TODAY\u2019S QUEUE</div>' +
    '<div class="qcards">' +
    qcard(qc.today, "Today's Jobs", 'TODAY') +
    qcard(qc.inProgress, 'In Progress', 'IN PROGRESS') +
    qcard(qc.waitingForInventory, 'Waiting for Inventory', 'TODAY', 'WAITING_FOR_INVENTORY') +
    qcard(qc.completedToday, 'Completed Today', 'COMPLETED') +
    '</div>' +
    /* Run 6: commercial pipeline cards — draft orders, open sales orders,
       and lines already released to the warehouse. */
    '<div class="sect">COMMERCIAL</div>' +
    '<div class="qcards">' +
    '<button class="qcard" data-croute="order">' +
      '<span class="qnum">' + getDraftOrdersLocal().length + '</span><span class="qlabel">Draft Orders</span></button>' +
    '<button class="qcard" data-croute="sales-orders/OPEN">' +
      '<span class="qnum">' + salesOrdersByTab('OPEN').length + '</span><span class="qlabel">Open Sales Orders</span></button>' +
    '<button class="qcard" data-croute="sales-orders/RELEASED">' +
      '<span class="qnum">' + salesOrdersByTab('RELEASED').length + '</span><span class="qlabel">Released to Warehouse</span></button>' +
    '</div>';
  return {
    html:
      '<div class="screen">' +
      pageHead('Good ' + daypart() + ', ' + esc(DB.data.currentEmployee || 'team') + '.',
               todayStr() + ' · FloorGuard Ops') +
      queueHtml +
      '<div class="sect">WAREHOUSE</div>' + tiles(wh) +
      '<div class="sect">OPERATIONS</div>' + tiles(ops) +
      '<div class="sect">SESSION</div>' +
      '<div class="card">' +
      '<div class="kv"><span class="k">Signed in as</span><span><strong>' +
        esc(DB.data.currentEmployee || '—') + '</strong></span></div>' +
      '<div class="kv"><span class="k">App version</span><span class="num">' + esc(APP_VERSION) + '</span></div>' +
      '<div class="kv"><span class="k">Storage</span><span class="mono">' + esc(DB.KEY) + '</span></div>' +
      '</div>' +
      '</div>',
    mount: function () {
      var ts = document.querySelectorAll('.tile');
      for (var i = 0; i < ts.length; i++) {
        (function (b) {
          b.onclick = function () { go(b.getAttribute('data-route')); };
        })(ts[i]);
      }
      var qs = document.querySelectorAll('.qcard');
      for (var j = 0; j < qs.length; j++) {
        (function (b) {
          b.onclick = function () {
            var cr = b.getAttribute('data-croute');
            if (cr) { go(cr); return; }
            go(b.getAttribute('data-qroute'));
          };
        })(qs[j]);
      }
    }
  };
};

Screens.settings = function () {
  var emps = DB.data.employees.map(function (e) {
    var you = (e === DB.data.currentEmployee) ? ' <span class="chip">YOU</span>' : '';
    return '<div class="kv"><span class="k">' + esc(e) + '</span><span>' + you + '</span></div>';
  }).join('');
  return {
    html:
      '<div class="screen">' +
      pageHead('⚙️ Settings', 'App and session') +
      '<div class="card"><h2>Session</h2>' +
      '<div class="kv"><span class="k">Signed in as</span><span><strong>' +
        esc(DB.data.currentEmployee || '—') + '</strong></span></div>' +
      '<button class="btn" id="set-switch" style="margin-top:14px">SWITCH EMPLOYEE</button>' +
      '<button class="btn" id="set-logout">SIGN OUT</button>' +
      '</div>' +
      '<div class="card"><h2>Employees on this device</h2>' + emps +
      '<form id="set-addform" style="margin-top:14px">' +
      '<label class="f" for="set-newname">Add employee</label>' +
      '<input type="text" id="set-newname" autocomplete="off" placeholder="Name">' +
      '<button class="btn btn-primary" type="submit">ADD EMPLOYEE</button>' +
      '</form></div>' +
      '<div class="card"><h2>Data mode</h2>' +
      '<div class="kv"><span class="k">Mode</span><span class="v" id="dm-mode">&mdash;</span></div>' +
      '<div class="kv"><span class="k">Sync</span><span class="v" id="dm-sync">&mdash;</span></div>' +
      '<div class="kv" id="dm-sessionrow" hidden><span class="k">Shared sign-in</span><span class="v" id="dm-session">&mdash;</span></div>' +
      '<div class="btn-row"><button class="btn" id="dm-local">LOCAL DEMO</button>' +
      '<button class="btn" id="dm-shared">SHARED PILOT</button></div>' +
      '<div id="dm-sharedcfg" hidden>' +
      '<div class="field"><label class="label" for="dm-url">SUPABASE URL</label>' +
      '<input class="input mono" id="dm-url" autocomplete="off" placeholder="https://xyzcompany.supabase.co"></div>' +
      '<div class="field"><label class="label" for="dm-key">SUPABASE ANON KEY</label>' +
      '<input class="input mono" id="dm-key" type="password" autocomplete="off" placeholder=""></div>' +
      '<div class="field"><label class="label" for="dm-email">EMPLOYEE EMAIL (shared sign-in)</label>' +
      '<input class="input" id="dm-email" autocomplete="off" autocapitalize="none" placeholder="you@warehouse.com"></div>' +
      '<div class="field"><label class="label" for="dm-pass">PASSWORD</label>' +
      '<input class="input" id="dm-pass" type="password" autocomplete="off" placeholder=""></div>' +
      '<div class="btn-row"><button class="btn btn-primary" id="dm-signin">SIGN IN</button>' +
      '<button class="btn" id="dm-signout">SIGN OUT</button></div>' +
      '<div class="btn-row"><button class="btn" id="dm-save">SAVE SETTINGS</button>' +
      '<button class="btn" id="dm-refresh">REFRESH NOW</button></div>' +
      '<button class="btn" id="dm-export">EXPORT LOCAL DATA</button>' +
      '<button class="btn" id="dm-import">IMPORT INTO SHARED BACKEND</button>' +
      '<p class="hint">The anon key is public by design; never paste a service-role key here. ' +
      'Stored settings stay on this device. Import never overwrites existing shared records &mdash; ' +
      'already-imported IDs are skipped.</p>' +
      '</div>' +
      '<div class="err" id="dm-err" hidden></div>' +
      '</div>' +
      '<div class="card"><h2>About</h2>' +
      '<div class="kv"><span class="k">Version</span><span class="num">' + esc(APP_VERSION) + ' (Run 6)</span></div>' +
      '<div class="kv"><span class="k">Storage key</span><span class="mono">' + esc(DB.KEY) + '</span></div>' +
      '<div class="kv"><span class="k">Schema</span><span class="num">v' + DB.SCHEMA + '</span></div>' +
      '</div>' +
      '<div class="card"><h2>Demo data</h2>' +
      '<button class="btn btn-danger" id="set-reset">RESET DEMO DATA</button>' +
      '</div>' +
      '</div>',
    mount: function () {
      $('#set-switch').onclick = function () { go('signin'); };
      $('#set-logout').onclick = doLogout;
      $('#set-addform').onsubmit = function (e) {
        e.preventDefault();
        var v = $('#set-newname').value;
        if (v && v.trim() && DB.data.employees.indexOf(v.trim()) < 0) {
          DB.data.employees.push(v.trim());
          DB.save();
          toast('Added ' + v.trim());
          render();
        }
      };
      $('#set-reset').onclick = function () {
        showConfirm({
          title: 'Reset demo data?',
          body: 'This clears employees, the session, and all module data on this device.',
          okLabel: 'RESET',
          onOk: function () { DB.reset(); go('signin'); }
        });
      };
      /* ---- Run 4: Data mode ---- */
      if (typeof Repository !== 'undefined') {
        var dmErr = function (m) { var e = $('#dm-err'); e.innerHTML = m; e.hidden = false; };
        var dmClearErr = function () { var e = $('#dm-err'); e.hidden = true; };
        var dmPaint = function () {
          var c = Repository.config;
          $('#dm-mode').textContent = Repository.mode === 'shared' ? 'SHARED PILOT' : 'LOCAL DEMO';
          $('#dm-sync').textContent = (typeof Sync !== 'undefined') ? Sync.state : '—';
          var sess = Repository.session();
          $('#dm-sessionrow').hidden = !(sess && sess.email);
          if (sess && sess.email) $('#dm-session').textContent = sess.email;
          $('#dm-sharedcfg').hidden = Repository.mode !== 'shared';
          if ($('#dm-url') && !$('#dm-url').value) $('#dm-url').value = c.supabaseUrl || '';
          if ($('#dm-key')) $('#dm-key').placeholder = c.supabaseAnonKey ? '•••••••• (saved)' : '';
          if ($('#dm-email') && !$('#dm-email').value) $('#dm-email').value = sess ? (sess.email || '') : '';
          updateSyncIndicator();
        };
        $('#dm-local').onclick = function () {
          dmClearErr();
          Repository.saveConfig({ dataProvider: 'local' });
          dmPaint();
          toast('Local Demo mode');
          render();
        };
        $('#dm-shared').onclick = function () {
          dmClearErr();
          var mode = Repository.saveConfig({ dataProvider: 'shared' });
          dmPaint();
          if (mode !== 'shared') dmErr('Enter the Supabase URL and anon key, then SAVE SETTINGS to enable Shared Pilot.');
          else toast('Shared Pilot mode');
          render();
        };
        $('#dm-save').onclick = function () {
          dmClearErr();
          var key = $('#dm-key').value.trim();
          var patch = { dataProvider: 'shared', supabaseUrl: $('#dm-url').value.trim() };
          if (key) patch.supabaseAnonKey = key; /* leave the stored key untouched when the field is blank */
          var mode = Repository.saveConfig(patch);
          $('#dm-key').value = '';
          dmPaint();
          if (mode !== 'shared') dmErr('Enter both the Supabase URL and the anon key to enable Shared Pilot.');
          else { toast('Shared settings saved'); render(); }
        };
        $('#dm-signin').onclick = function () {
          dmClearErr();
          var em = $('#dm-email').value.trim(), pw = $('#dm-pass').value;
          if (!em || !pw) { dmErr('Enter the employee email and password.'); return; }
          Repository.signIn(em, pw).then(function () {
            $('#dm-pass').value = '';
            dmPaint(); toast('Signed in for shared writes');
          }).catch(function (err) {
            dmErr(esc(err && err.message ? err.message : 'Sign-in failed.'));
          });
        };
        $('#dm-signout').onclick = function () {
          dmClearErr();
          Repository.signOut().then(function () { dmPaint(); toast('Signed out of shared backend'); })
            .catch(function (err) { dmErr(esc(err && err.message ? err.message : 'Sign-out failed.')); });
        };
        $('#dm-refresh').onclick = function () {
          dmClearErr();
          Repository.refresh().then(function () { dmPaint(); toast('Refreshed from shared backend'); render(); })
            .catch(function (err) { dmErr(esc(err && err.message ? err.message : 'Refresh failed.')); });
        };
        $('#dm-export').onclick = function () {
          dmClearErr();
          var snap = Repository.exportLocal();
          var blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'floorguard-local-export.json';
          document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
          toast('Local data exported');
        };
        $('#dm-import').onclick = function () {
          dmClearErr();
          showConfirm({
            title: 'Import local data into the shared backend?',
            body: 'Uploads this device\u2019s local records into the shared database. Existing shared records are never overwritten — already-imported IDs are skipped. Sign in first.',
            okLabel: 'IMPORT'
          }).then(function (ok) {
            if (!ok) return;
            var snap = Repository.exportLocal();
            Repository.importShared(snap).then(function (r) {
              var s = (r && r.summary) || {};
              toast('Imported: ' + (s.rolls || 0) + ' rolls, ' + (s.cuts || 0) + ' cuts, ' +
                (s.assignments || 0) + ' assignments' +
                (s.skipped ? ' (' + s.skipped + ' already present — skipped)' : ''));
              dmPaint(); render();
            }).catch(function (err) {
              dmErr(esc(err && err.message ? err.message : 'Import failed.'));
            });
          });
        };
        dmPaint();
      }
    }
  };
};

/* Register a placeholder screen for every future module. */
Object.keys(MODULE_INFO).forEach(function (k) {
  if (k === 'settings') return; /* settings is a real screen above */
  Screens[k] = function () { return moduleScreen(k); };
});

/* ======================================================================
   RUN 2 (consolidation): module hubs + Work Orders + Balance.
   Hand-authored for the Ops shell; they drive the ported warehouse core.
   ====================================================================== */

/* ---------------- CYCLE COUNT hub ---------------- */
Screens['cycle-count'] = function () {
  var disc = discrepancyRolls().length;
  var html =
    '<div class="screen">' +
    pageHead('🔄 Cycle Count', 'Free Run · Rapid · Verified') +
    '<button class="btn btn-free btn-huge" id="cc-free">🆓 FREE RUN CYCLE COUNT<br><span class="btn-sub">DISCOVERY MODE — any location, any roll</span></button>' +
    '<button class="btn btn-huge" id="cc-rapid">⚡ RAPID CYCLE COUNT<br><span class="btn-sub">scan location once, then roll after roll</span></button>' +
    '<button class="btn btn-primary btn-huge" id="cc-std">▶ STANDARD / VERIFIED COUNT<br><span class="btn-sub">compare against system inventory</span></button>' +
    '<button class="btn btn-huge" id="cc-sess">📋 COUNT SESSIONS</button>' +
    '<button class="btn btn-huge" id="cc-rev">⚠️ ITEMS REQUIRING REVIEW' +
      (disc ? ' <span class="count-badge">' + disc + '</span>' : '') + '</button>' +
    '<p class="hint">Free Run collects physical reality with no preloaded inventory. ' +
    'Standard mode compares against expected locations and balances.</p>' +
    '</div>';
  return { html: html, mount: function () {
    $('#cc-free').onclick = function () { newFreeRun(); go('count/free/loc'); };
    $('#cc-rapid').onclick = function () { newRapid(); go('count/rapid/loc'); };
    $('#cc-std').onclick = function () { newSession(); go('count/standard'); };
    $('#cc-sess').onclick = function () { go('count/sessions'); };
    $('#cc-rev').onclick = function () { go('count/review'); };
  }};
};

/* ---------------- CUT / ROLL TRACKING hub ---------------- */
Screens['cut-roll-tracking'] = function () {
  var cuts = FG().cuts.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); }).slice(0, 8);
  var rows = cuts.map(function (c) {
    return '<button class="rowbtn" data-roll="' + esc(c.rollId) + '">' +
      '<div class="rhead"><b class="mono">' + esc(c.rollId) + '</b>' +
      ' <span class="sub">cut <b class="num">' + fmtLen(c.inches) + '</b></span></div>' +
      '<div class="sub">' + (c.order ? 'Order <b class="mono">' + esc(c.order) + '</b> &middot; ' : '') +
      esc(c.by) + ' &middot; ' + fmtDT(c.at) + '</div></button>';
  }).join('');
  var html =
    '<div class="screen">' +
    pageHead('✂️ Cut / Roll Tracking', 'Scan · balance · cut · history') +
    '<button class="btn btn-primary btn-huge" id="crt-cut">📷 SCAN ROLL TO CUT</button>' +
    '<button class="btn btn-huge" id="crt-view">🔍 SCAN ROLL TO VIEW</button>' +
    '<button class="btn btn-huge" id="crt-search">⌨️ SEARCH ROLL</button>' +
    '<h2>Recent cuts</h2>' +
    (rows || '<p class="hint">No cuts recorded yet.</p>') +
    '</div>';
  return { html: html, mount: function () {
    $('#crt-cut').onclick = function () { newCutSession(); go('cut/scan'); };
    $('#crt-view').onclick = function () { go('rolls/scan'); };
    $('#crt-search').onclick = function () { go('rolls/search'); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-roll]'), function (b) {
      b.onclick = function () { go('roll', b.getAttribute('data-roll')); };
    });
  }};
};

/* Generic "scan a roll, then open it" used by the Cut/Roll hub. */
Screens['rolls/scan'] = function () {
  var html =
    '<div class="screen">' +
    '<div class="step-head">SCAN ROLL</div>' +
    '<h1>Scan a roll</h1>' +
    '<div class="cambox" id="cambox"></div>' +
    '<div id="result"></div>' +
    '<div class="card"><div class="label">TYPE THE BARCODE</div>' +
    '<form id="manualform"><div class="field"><input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN"></div>' +
    '<button class="btn btn-primary" type="submit">FIND ROLL</button></form></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
  }};
  function onCode(code) {
    var norm = normalizeBarcode(code);
    if (!norm) { bad(); return; }
    var roll = rollByBarcode(norm);
    if (roll) { good(); go('roll', roll.id); return; }
    var d = findDiscovered(norm);
    if (d) { good(); go('disc', d.id); return; }
    bad();
    $('#result').innerHTML = '<div class="err center">&#10060; ROLL NOT FOUND<br>' +
      '<span style="font-size:1rem">"' + esc(norm) + '" is not in the system.</span></div>' +
      '<button class="btn btn-free" id="todisc">🆓 OPEN IN FREE RUN (DISCOVERY)</button>';
    $('#todisc').onclick = function () { newFreeRun(); go('count/free/loc'); };
  }
};

/* ---------------- BALANCE ---------------- */
Screens['balance'] = function () {
  var rows = FG().rolls.map(function (r) {
    var exp = systemBalance(r.id);
    var meas = (r.measuredIn != null) ? fmtLen(r.measuredIn) : '—';
    var diff = (r.measuredIn != null) ? fmtDiff(r.measuredIn - exp) : '—';
    var dcls = (r.measuredIn != null) ? diffCls(r.measuredIn - exp) : '';
    return '<button class="rowbtn" data-roll="' + esc(r.id) + '">' +
      '<div class="rhead"><b class="mono">' + esc(r.id) + '</b>' +
      (r.measuredIn != null ? ' <span class="stchip st-green">MB ✓</span>' : '') + '</div>' +
      '<div class="sub">' + esc(r.style) + ' &middot; ' + esc(r.color) + ' &middot; loc <b class="mono">' + esc(r.expectedLocation) + '</b></div>' +
      '<div class="sub num">Exp <b>' + fmtLen(exp) + '</b> &middot; Meas <b>' + meas + '</b>' +
      ' &middot; Diff <b class="' + dcls + '">' + diff + '</b></div></button>';
  }).join('');
  return {
    html:
      '<div class="screen">' +
      pageHead('⚖️ Balance', 'Expected vs measured per roll') +
      (rows || '<p class="hint">No rolls in the system.</p>') +
      '</div>',
    mount: function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-roll]'), function (b) {
        b.onclick = function () { go('roll', b.getAttribute('data-roll')); };
      });
    }
  };
};

/* ---------------- WORK ORDERS ---------------- */
function woById(id) {
  return (FG().workOrders || []).filter(function (w) { return w.id === id; })[0] || null;
}
/* Find a work order by its printed number (scan/wedge or typed). */
function woByNumber(num) {
  var n = String(num || '').trim().toUpperCase();
  if (!n) return null;
  return (FG().workOrders || []).filter(function (w) {
    return String(w.number || '').trim().toUpperCase() === n ||
           String(w.id || '').trim().toUpperCase() === n;
  })[0] || null;
}
function woAssigneeName(w) {
  if (!w.assigneeId) return null;
  var m = /^e(\d+)$/.exec(w.assigneeId || '');
  var n = m ? DB.data.employees[parseInt(m[1], 10) - 1] : null;
  return n || w.assigneeId;
}
function woAssignChip(w) {
  var nm = woAssigneeName(w);
  return nm
    ? '<span class="stchip st-green">ASSIGNED' + ' \u00b7 ' + esc(nm) + '</span>'
    : '<span class="stchip st-yellow">UNASSIGNED</span>';
}
function woStatusChip(w) {
  var cls = w.opStatus === 'COMPLETE' ? 'st-green' : (w.opStatus === 'IN_PROGRESS' ? 'st-blue' : 'st-gray');
  return '<span class="stchip ' + cls + '">' + esc(w.opStatus) + '</span>';
}

Screens['work-orders'] = function (param) {
  var tab = (param || 'ALL').toUpperCase();
  if (['ALL', 'ASSIGNED', 'UNASSIGNED'].indexOf(tab) < 0) tab = 'ALL';
  var list = (FG().workOrders || []).filter(function (w) {
    if (tab === 'ASSIGNED') return !!w.assigneeId;
    if (tab === 'UNASSIGNED') return !w.assigneeId;
    return true;
  });
  var tabs = ['ALL', 'ASSIGNED', 'UNASSIGNED'].map(function (t) {
    return '<button class="fchip' + (t === tab ? ' on' : '') + '" data-tab="' + t + '">' + t + '</button>';
  }).join('');
  var rows = list.map(function (w) {
    return '<button class="rowbtn" data-wo="' + esc(w.id) + '">' +
      '<div class="rhead"><b class="mono">' + esc(w.number) + '</b> ' + woAssignChip(w) + ' ' + woStatusChip(w) + '</div>' +
      '<div class="sub">' + esc(w.property) + ' &middot; ' + esc(w.account) + '</div>' +
      '<div class="sub">' + esc(w.style) + ' &middot; ' + esc(w.color) + ' &middot; ' + fmtWidth(w.widthIn) +
      (w.rollId ? ' &middot; roll <b class="mono">' + esc(w.rollId) + '</b>' : '') + '</div></button>';
  }).join('');
  var html =
    '<div class="screen">' +
    pageHead('🧾 Work Orders', 'Assign · track · cut against') +
    '<div class="chiprow">' + tabs + '</div>' +
    (rows || '<p class="hint center">No work orders in this view.</p>') +
    '</div>';
  return { html: html, mount: function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { go('work-orders', b.getAttribute('data-tab')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-wo]'), function (b) {
      b.onclick = function () { go('work-order', b.getAttribute('data-wo')); };
    });
  }};
};

Screens['work-order'] = function (param) {
  var w = woById(param);
  if (!w) { setTimeout(function () { go('work-orders'); }, 0); return { html: '' }; }
  var roll = w.rollId ? rollById(w.rollId) : null;
  var cuts = FG().cuts.filter(function (c) { return c.order === w.number; })
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  var empOpts = DB.data.employees.map(function (e, i) {
    var eid = 'e' + (i + 1);
    return '<option value="' + eid + '"' + (w.assigneeId === eid ? ' selected' : '') + '>' + esc(e) + '</option>';
  }).join('');
  var rollOpts = FG().rolls.map(function (r) {
    return '<option value="' + esc(r.id) + '"' + (w.rollId === r.id ? ' selected' : '') + '>' +
      esc(r.id) + ' — ' + esc(r.style) + ' (' + fmtLen(systemBalance(r.id)) + ')</option>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">← BACK</button>' +
    '<div class="step-head">WORK ORDER</div>' +
    '<h1 class="mono">' + esc(w.number) + '</h1>' +
    '<div>' + woAssignChip(w) + ' ' + woStatusChip(w) + '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Property</span><span class="v">' + esc(w.property) + '</span></div>' +
      '<div class="kv"><span class="k">Account</span><span class="v">' + esc(w.account) + '</span></div>' +
      '<div class="kv"><span class="k">Style / Color</span><span class="v">' + esc(w.style) + ' / ' + esc(w.color) + '</span></div>' +
      '<div class="kv"><span class="k">Material</span><span class="v">' + esc(w.materialType) + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + fmtWidth(w.widthIn) + '</span></div>' +
      '<div class="kv"><span class="k">Quantity</span><span class="v num">' + esc(String(w.quantity)) + ' ' + esc(w.uom) + '</span></div>' +
    '</div>' +
    /* Run 6: source sales order traceability card. */
    (w.salesOrderId ? (function () {
      var sso = salesOrderById(w.salesOrderId);
      var slo = sso && soLineById(sso, w.salesOrderLineId);
      return '<h2>Source sales order</h2>' +
        '<div class="card">' +
        '<div class="kv"><span class="k">Sales order</span><span class="v mono"><b>' +
          esc(sso ? sso.number : w.salesOrderId) + '</b></span></div>' +
        (slo ? '<div class="kv"><span class="k">Material line</span><span class="v">LINE ' + slo.seq +
          ' · ' + esc(slo.style) + ' · ' + esc(orderItemQtyDisplay(slo)) + '</span></div>' : '') +
        '<button class="btn" id="wo-so">VIEW SALES ORDER</button>' +
        '</div>';
    })() : '') +
    '<h2>Assigned inventory</h2>' +
    '<div class="card">' +
      (roll
        ? '<div class="kv"><span class="k">Roll</span><span class="v mono"><b>' + esc(roll.id) + '</b></span></div>' +
          '<div class="kv"><span class="k">Roll balance</span><span class="v num">' + fmtLen(systemBalance(roll.id)) + '</span></div>' +
          '<button class="btn" id="goroll">VIEW ROLL</button>'
        : '<p class="hint">No roll assigned yet.</p>') +
      '<div class="field"><label class="label" for="wo-roll">LINK ROLL</label>' +
      '<select class="input" id="wo-roll"><option value="">— choose a roll —</option>' + rollOpts + '</select></div>' +
      '<div class="btn-row"><button class="btn btn-primary" id="wo-linkroll" style="flex:1">LINK ROLL</button>' +
      '<button class="btn" id="wo-scanroll" style="flex:1">📷 SCAN TO LINK</button></div>' +
    '</div>' +
    '<h2>Assignment</h2>' +
    '<div class="card">' +
      '<div class="field"><label class="label" for="wo-emp">ASSIGNED EMPLOYEE</label>' +
      '<select class="input" id="wo-emp"><option value="">— unassigned —</option>' + empOpts + '</select></div>' +
      '<button class="btn btn-primary" id="wo-assign">SAVE ASSIGNMENT</button>' +
    '</div>' +
    '<h2>Schedule</h2>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Scheduled</span><span class="v num">' +
        (w.scheduledDate ? sjFmtDate(w.scheduledDate) + (w.scheduledTime ? ' · ' + esc(w.scheduledTime) : '') : 'Not scheduled') + '</span></div>' +
      '<div class="kv"><span class="k">Priority</span><span class="v">' + sjPriorityChip(w.priority) + '</span></div>' +
      '<div class="kv"><span class="k">Current step</span><span class="v"><b>' + esc(currentWarehouseStep(w).replace(/_/g, ' ')) + '</b></span></div>' +
      '<div class="kv"><span class="k">Readiness</span><span class="v">' + sjReadinessChip(jobReadiness(w)) + '</span></div>' +
      '<div class="kv"><span class="k">Inventory</span><span class="v">' + esc(sjInvText(w)) + '</span></div>' +
      '<div class="kv"><span class="k">Cut status</span><span class="v">' + esc(woCutStatus(w).state) + '</span></div>' +
      '<button class="btn" id="wo-sj">🗓️ VIEW IN SCHEDULED JOBS</button>' +
    '</div>' +
    '<h2>Status</h2>' +
    '<div class="btn-row">' +
      '<button class="btn" id="wo-start" style="flex:1">▶ START WORK</button>' +
      '<button class="btn" id="wo-complete" style="flex:1">✔ COMPLETE</button>' +
    '</div>' +
    '<h2>Cut activity</h2>' +
    (cuts.length ? cuts.map(function (c) {
      return '<button class="rowbtn" data-roll="' + esc(c.rollId) + '">' +
        '<div class="rhead"><b class="mono">' + esc(c.rollId) + '</b>' +
        ' <span class="sub">cut <b class="num">' + fmtLen(c.inches) + '</b></span></div>' +
        '<div class="sub">' + esc(c.by) + ' &middot; ' + fmtDT(c.at) + ' &middot; new bal <b class="num">' + fmtLen(c.newIn) + '</b></div></button>';
    }).join('') : '<p class="hint">No cuts recorded against this work order yet.</p>') +
    '<h2>Inventory activity</h2>' +
    (function () {
      var evts = assignEventsForWO(w.id);
      return evts.length ? evts.map(function (e) {
        return '<div class="trow"><div><b>' + esc(aiEventLabel(e.action)) + '</b>' +
          (e.rollId ? ' <span class="mono">' + esc(e.rollId) + '</span>' : '') +
          (e.detail ? '<div class="sub">' + esc(e.detail) + '</div>' : '') + '</div>' +
          '<div class="sub">' + esc(e.user) + '<br>' + fmtDT(e.at) + '</div></div>';
      }).join('') : '<p class="hint">No inventory assignments yet.</p>';
    })() +
    '<button class="btn btn-primary btn-huge" id="wo-cut">✂️ CUT ROLL FOR THIS ORDER</button>' +
    '<button class="btn btn-primary btn-huge" id="wo-inv">🗂️ CONTINUE TO INVENTORY</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    if ($('#goroll')) $('#goroll').onclick = function () { go('roll', w.rollId); };
    if ($('#wo-so')) $('#wo-so').onclick = function () { go('sales-order', w.salesOrderId); };
    $('#wo-sj').onclick = function () { go('scheduled-job/' + w.id); };
    $('#wo-assign').onclick = function () {
      w.assigneeId = $('#wo-emp').value || null;
      DB.save(); good(); render();
    };
    $('#wo-linkroll').onclick = function () {
      var rid = $('#wo-roll').value;
      if (!rid) { bad(); return; }
      w.rollId = rid;
      if (w.opStatus === 'OPEN') w.opStatus = 'IN_PROGRESS';
      DB.save(); good(); render();
    };
    $('#wo-scanroll').onclick = function () { go('work-order/link', w.id); };
    $('#wo-start').onclick = function () { w.opStatus = 'IN_PROGRESS'; DB.save(); good(); render(); };
    $('#wo-complete').onclick = function () {
      showConfirm({ title: 'Complete ' + w.number + '?', body: 'Marks the work order COMPLETE.', okLabel: 'COMPLETE' })
        .then(function (ok) { if (ok) { w.opStatus = 'COMPLETE'; DB.save(); good(); render(); } });
    };
    $('#wo-cut').onclick = function () {
      newCutSession();
      if (w.rollId && rollById(w.rollId)) { C.roll = rollById(w.rollId); C.woId = w.id; go('cut/entry'); }
      else go('cut/scan');
    };
    /* Run 3: WORK ORDERS -> OPEN -> CONTINUE TO INVENTORY -> assign flow. */
    $('#wo-inv').onclick = function () { go('assign-inventory/wo', w.id); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-roll]'), function (b) {
      b.onclick = function () { go('roll', b.getAttribute('data-roll')); };
    });
  }};
};

/* Scan a roll to link it to a work order (assign inventory). */
Screens['work-order/link'] = function (param) {
  var w = woById(param);
  if (!w) { setTimeout(function () { go('work-orders'); }, 0); return { html: '' }; }
  var html =
    '<div class="screen">' +
    '<div class="step-head">LINK ROLL — ' + esc(w.number) + '</div>' +
    '<h1>Scan the roll</h1>' +
    '<div class="cambox" id="cambox"></div>' +
    '<div id="result"></div>' +
    '<div class="card"><div class="label">TYPE THE BARCODE</div>' +
    '<form id="manualform"><div class="field"><input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN"></div>' +
    '<button class="btn btn-primary" type="submit">LINK THIS ROLL</button></form></div>' +
    '<button class="btn" id="cancel">CANCEL</button>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    $('#cancel').onclick = function () { go('work-order', w.id); };
  }};
  function onCode(code) {
    var norm = normalizeBarcode(code);
    var roll = norm && rollByBarcode(norm);
    if (!roll) {
      bad();
      $('#result').innerHTML = '<div class="err center">&#10060; ROLL NOT FOUND — try again.</div>';
      return;
    }
    w.rollId = roll.id;
    if (w.opStatus === 'OPEN') w.opStatus = 'IN_PROGRESS';
    DB.save(); good();
    go('work-order', w.id);
  }
};
/* ---------------- ASSIGN INVENTORY screens (Run 3) ---------------- */
var AI = null;    /* assign-flow session: { woId, lineId, rollId, discCode, phase } */
var AIHUB = { tab: 'needs', q: '', emp: '', prop: '', mtype: '', date: '' };

function aiLineStatusChip(st) {
  var map = { NOT_ASSIGNED: ['st-red', 'NOT ASSIGNED'],
    PARTIALLY_ASSIGNED: ['st-yellow', 'PARTIALLY ASSIGNED'],
    ASSIGNED: ['st-green', 'ASSIGNED'],
    COMPLETED: ['st-green', 'COMPLETED'] };
  var m = map[st] || map.NOT_ASSIGNED;
  return '<span class="stchip ' + m[0] + '">' + m[1] + '</span>';
}
function aiAssignStatusChip(st) {
  var map = { RESERVED: ['st-blue', 'RESERVED'], RELEASED: ['st-yellow', 'RELEASED'],
    CONSUMED: ['st-green', 'CONSUMED'] };
  var m = map[st] || ['st-yellow', st];
  return '<span class="stchip ' + m[0] + '">' + m[1] + '</span>';
}
function aiCompatBanner(compat) {
  if (compat.verdict === 'MATCH')
    return '<div class="ok-panel"><div class="big-ok">&#10003; MATERIAL MATCH</div></div>';
  if (compat.verdict === 'INCOMPLETE')
    return '<div class="warn-panel"><div class="big-ok">MATERIAL DATA INCOMPLETE</div>' +
      '<p class="hint">Missing: ' + esc(compat.missing.join(', ')) +
      '. Supervisor review required before assigning.</p></div>';
  var rows = compat.mismatches.map(function (m) {
    return '<div class="kv"><span class="k">' + esc(m.field) + '</span><span class="v">roll <b>' +
      esc(String(m.roll)) + '</b> vs line <b>' + esc(String(m.line)) + '</b></span></div>';
  }).join('');
  return '<div class="warn-panel"><div class="big-ok">&#9888;&#65039; MATERIAL MISMATCH</div>' + rows +
    '<p class="hint">Clearly mismatched material is never assigned silently — a supervisor must approve.</p></div>';
}
/* ---------------- scheduled jobs / daily warehouse queue UI (Run 5) -----
   The daily screen for warehouse employees: what is due today, what is
   coming, what is in progress, what is done. Tabs + MY JOBS + filters +
   job cards with one next action. All data via Repository (Run 4). */
var SJ = null;
function sjState() {
  if (!SJ) SJ = { tab: 'TODAY', my: false, unassigned: false, q: '',
    sort: 'schedule', fStatus: '', fPriority: '', fEmployee: '', fProperty: '',
    fMaterial: '', fInv: '', jobs: null, dateFrom: '', dateTo: '' };
  return SJ;
}
function sjReadinessChip(r) {
  var cls = r === JOB_STATES.COMPLETED ? 'st-green'
    : r === JOB_STATES.ON_HOLD ? 'st-red'
    : r === JOB_STATES.WAITING_FOR_INVENTORY ? 'st-yellow'
    : r === JOB_STATES.READY_TO_CUT ? 'st-green'
    : r === JOB_STATES.IN_PROGRESS ? 'st-blue' : 'st-gray';
  return '<span class="stchip ' + cls + '">' + esc(r) + '</span>';
}
function sjPriorityChip(p) {
  p = p || 'NORMAL';
  var cls = p === 'URGENT' ? 'st-orange' : (p === 'HIGH' ? 'st-yellow' : 'st-gray');
  return '<span class="stchip ' + cls + '">' + esc(p) + '</span>';
}
function sjFmtDate(ds) {
  if (!ds) return '—';
  var p = ds.split('-');
  return Number(p[1]) + '/' + Number(p[2]);
}
function sjGroupLabel(ds, today) {
  if (ds === addDaysStr(today, 1)) return 'TOMORROW';
  var diff = Math.round((dateStrToDate(ds) - dateStrToDate(today)) / 86400000);
  if (diff >= 7) return 'NEXT WEEK';
  return dateStrToDate(ds).toLocaleDateString([], { weekday: 'long' }).toUpperCase();
}
function sjInvText(wo) {
  var ir = inventoryReadiness(wo);
  if (typeof ir === 'string') return ir;
  return ir.parts.map(function (p) { return p.text; }).join(' · ');
}
function sjMatches(wo, q) {
  if (!q) return true;
  q = q.toUpperCase();
  var hay = [wo.number, wo.id, wo.property, wo.account, woAssigneeName(wo) || '']
    .concat((wo.lines || []).map(function (l) { return (l.style || '') + ' ' + (l.color || '') + ' ' + (l.materialType || ''); }))
    .concat((FG().inventoryAssignments || []).filter(function (a) { return a.workOrderId === wo.id; })
      .map(function (a) { return a.rollId || ''; }))
    .join(' ').toUpperCase();
  return hay.indexOf(q) !== -1;
}
/* Apply tab + toggles + search + filters + sort. Returns display list. */
function sjFiltered() {
  var s = sjState(), today = warehouseToday();
  var list = (s.jobs || []).slice();
  var eid = currentAssigneeId();
  if (s.tab === 'TODAY') list = list.filter(function (w) { return w.scheduledDate === today; });
  else if (s.tab === 'UPCOMING') list = list.filter(function (w) { return w.scheduledDate && w.scheduledDate > today; });
  else if (s.tab === 'IN PROGRESS') list = list.filter(function (w) { return jobReadiness(w) === JOB_STATES.IN_PROGRESS; });
  else if (s.tab === 'COMPLETED') {
    list = list.filter(function (w) { return jobReadiness(w) === JOB_STATES.COMPLETED; });
    /* Useful recent window: last 14 days unless a date filter says otherwise. */
    if (!s.dateFrom && !s.dateTo) {
      var cutoff = addDaysStr(today, -14);
      list = list.filter(function (w) {
        return !w.warehouseCompletedAt || w.warehouseCompletedAt.slice(0, 10) >= cutoff;
      });
    }
  }
  if (s.my) list = list.filter(function (w) { return w.assigneeId && w.assigneeId === eid; });
  if (s.unassigned) list = list.filter(function (w) { return !w.assigneeId; });
  if (s.q) list = list.filter(function (w) { return sjMatches(w, s.q); });
  if (s.fStatus) list = list.filter(function (w) { return jobReadiness(w) === s.fStatus; });
  if (s.fPriority) list = list.filter(function (w) { return (w.priority || 'NORMAL') === s.fPriority; });
  if (s.fEmployee) list = list.filter(function (w) { return w.assigneeId === s.fEmployee; });
  if (s.fProperty) list = list.filter(function (w) { return w.property === s.fProperty; });
  if (s.fMaterial) list = list.filter(function (w) {
    return (w.lines || []).some(function (l) { return l.materialType === s.fMaterial; });
  });
  if (s.fInv) list = list.filter(function (w) {
    var ir = sjInvText(w);
    if (s.fInv === 'NOT ASSIGNED') return ir === 'NOT ASSIGNED';
    if (s.fInv === 'PARTIAL') return ir.indexOf('NOT ASSIGNED') >= 0 && ir !== 'NOT ASSIGNED';
    if (s.fInv === 'COMPLETE') return ir.indexOf('NOT ASSIGNED') < 0 && ir.indexOf('RESERVED') < 0;
    return true;
  });
  if (s.dateFrom) list = list.filter(function (w) { return w.scheduledDate && w.scheduledDate >= s.dateFrom; });
  if (s.dateTo) list = list.filter(function (w) { return w.scheduledDate && w.scheduledDate <= s.dateTo; });
  var priRank = function (w) { return w.priority === 'URGENT' ? 0 : (w.priority === 'HIGH' ? 1 : 2); };
  var byNum = function (a, b) { return String(a.number).localeCompare(String(b.number)); };
  list.sort(function (a, b) {
    if (s.sort === 'property') return String(a.property).localeCompare(String(b.property)) || byNum(a, b);
    if (s.sort === 'status') return jobReadiness(a).localeCompare(jobReadiness(b)) || byNum(a, b);
    if (s.sort === 'employee') return String(woAssigneeName(a) || '').localeCompare(String(woAssigneeName(b) || '')) || byNum(a, b);
    if (s.sort === 'wo') return byNum(a, b);
    /* schedule: priority, then time, then WO number */
    var pr = priRank(a) - priRank(b); if (pr) return pr;
    var ta = a.scheduledTime || '', tb = b.scheduledTime || '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    var da = a.scheduledDate || '', db = b.scheduledDate || '';
    if (da !== db) return da < db ? -1 : 1;
    return byNum(a, b);
  });
  return list;
}
function sjJobCard(wo) {
  var r = jobReadiness(wo);
  var qa = jobQuickAction(wo);
  var emp = woAssigneeName(wo);
  var lines = (wo.lines || []).map(function (l) {
    return esc(l.style || '') + ' / ' + esc(l.color || '');
  }).join(' · ');
  var qty = (wo.lines || []).map(function (l) { return fmtLen(l.requiredIn || 0); }).join(' + ');
  var mat = ((wo.lines || [])[0] || {}).materialType || '';
  var ir = inventoryReadiness(wo);
  var invHtml;
  if (typeof ir === 'string') {
    invHtml = '<span class="stchip st-yellow">' + esc(ir) + '</span>';
  } else {
    invHtml = ir.parts.map(function (p) {
      var inner = p.rollId
        ? '<button class="linkbtn" data-roll="' + esc(p.rollId) + '">ROLL ' + esc(p.rollId) + '</button>' +
          (p.text.indexOf('·') >= 0 ? ' · ' + esc(p.text.split('·')[1].trim()) : '')
        : esc(p.text);
      return '<span class="stchip ' + p.cls + '">' + inner + '</span>';
    }).join(' ');
  }
  var sched = wo.scheduledDate ? sjFmtDate(wo.scheduledDate) + (wo.scheduledTime ? ' · ' + esc(wo.scheduledTime) : '') : '—';
  return '<div class="card sjcard" data-job="' + esc(wo.id) + '">' +
    '<div class="rhead"><b class="mono big">' + esc(wo.number) + '</b> ' + sjPriorityChip(wo.priority) + ' ' + sjReadinessChip(r) + '</div>' +
    '<div class="sub"><b>' + esc(wo.property) + '</b> · ' + esc(wo.account) + '</div>' +
    '<div class="sub">' + lines + '</div>' +
    '<div class="sub">' + esc(mat) + ' · <b class="num">' + esc(qty) + '</b></div>' +
    '<div class="kv"><span class="k">Inventory</span><span>' + invHtml + '</span></div>' +
    '<div class="kv"><span class="k">Worker</span><span>' + (emp ? '<b>' + esc(emp) + '</b>' : '<span class="stchip st-yellow">UNASSIGNED</span>') + '</span></div>' +
    '<div class="kv"><span class="k">Scheduled</span><span class="num">' + sched + '</span></div>' +
    '<div class="btn-row"><button class="btn btn-primary" data-qa="' + esc(wo.id) + '" style="flex:1">' + esc(qa.label) + '</button>' +
    '<button class="btn" data-detail="' + esc(wo.id) + '">DETAIL</button></div>' +
    '</div>';
}
function sjTabCounts() {
  var s = sjState(), today = warehouseToday(), jobs = s.jobs || [];
  var c = { TODAY: 0, UPCOMING: 0, 'IN PROGRESS': 0, COMPLETED: 0 };
  jobs.forEach(function (w) {
    if (w.scheduledDate === today) c.TODAY++;
    if (w.scheduledDate && w.scheduledDate > today) c.UPCOMING++;
    if (jobReadiness(w) === JOB_STATES.IN_PROGRESS) c['IN PROGRESS']++;
    if (jobReadiness(w) === JOB_STATES.COMPLETED) c.COMPLETED++;
  });
  return c;
}
Screens['scheduled-jobs'] = function (param) {
  var s = sjState();
  /* Route param: TAB or TAB/STATUSFILTER, e.g. scheduled-jobs/TODAY */
  var parts = String(param || '').split('/');
  var tab = (parts[0] || '').toUpperCase();
  if (['TODAY', 'UPCOMING', 'IN PROGRESS', 'COMPLETED'].indexOf(tab) >= 0) s.tab = tab;
  if (parts[1]) s.fStatus = decodeURIComponent(parts[1]).toUpperCase().replace(/_/g, ' ');
  var isSup = isSupervisorRole(DB.data.currentEmployee);
  var emps = (DB.data.employees || []).map(function (e, i) { return { id: 'e' + (i + 1), name: e }; });
  var props = [], mats = [];
  (s.jobs || []).forEach(function (w) {
    if (w.property && props.indexOf(w.property) < 0) props.push(w.property);
    (w.lines || []).forEach(function (l) {
      if (l.materialType && mats.indexOf(l.materialType) < 0) mats.push(l.materialType);
    });
  });
  function opt(v, label, cur) {
    return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
  }
  var tabs = ['TODAY', 'UPCOMING', 'IN PROGRESS', 'COMPLETED'].map(function (t) {
    return '<button class="fchip' + (t === s.tab ? ' on' : '') + '" data-tab="' + t + '">' + t +
      ' <b class="badge" data-badge="' + t + '"></b></button>';
  }).join('');
  var html =
    '<div class="screen">' +
    pageHead('🗓️ Scheduled Jobs', 'The daily warehouse queue') +
    '<div class="chiprow">' + tabs + '</div>' +
    '<div class="chiprow">' +
      '<button class="fchip' + (s.my ? ' on' : '') + '" data-my="1">MY JOBS</button>' +
      (isSup ? '<button class="fchip' + (s.unassigned ? ' on' : '') + '" data-un="1">UNASSIGNED</button>' : '') +
      '<button class="btn btn-small" id="sj-refresh" style="margin-left:auto">⟳ REFRESH</button>' +
    '</div>' +
    '<div class="card"><div class="field"><label class="label" for="sj-q">SEARCH</label>' +
    '<input class="input" id="sj-q" placeholder="Work order · property · roll · employee" value="' + esc(s.q) + '"></div>' +
    '<div class="frow">' +
      '<div class="field"><label class="label">STATUS</label><select class="input" id="sj-fstatus">' +
        opt('', 'All', s.fStatus) + Object.keys(JOB_STATES).map(function (k) { return opt(JOB_STATES[k], JOB_STATES[k], s.fStatus); }).join('') + '</select></div>' +
      '<div class="field"><label class="label">PRIORITY</label><select class="input" id="sj-fpri">' +
        opt('', 'All', s.fPriority) + ['NORMAL', 'HIGH', 'URGENT'].map(function (p) { return opt(p, p, s.fPriority); }).join('') + '</select></div>' +
    '</div>' +
    '<div class="frow">' +
      '<div class="field"><label class="label">EMPLOYEE</label><select class="input" id="sj-femp">' +
        opt('', 'All', s.fEmployee) + emps.map(function (e) { return opt(e.id, e.name, s.fEmployee); }).join('') + '</select></div>' +
      '<div class="field"><label class="label">SORT</label><select class="input" id="sj-sort">' +
        opt('schedule', 'Schedule', s.sort) + opt('property', 'Property', s.sort) +
        opt('status', 'Status', s.sort) + opt('employee', 'Employee', s.sort) +
        opt('wo', 'Work Order', s.sort) + '</select></div>' +
    '</div>' +
    '<div class="frow">' +
      '<div class="field"><label class="label">PROPERTY</label><select class="input" id="sj-fprop">' +
        opt('', 'All', s.fProperty) + props.map(function (p) { return opt(p, p, s.fProperty); }).join('') + '</select></div>' +
      '<div class="field"><label class="label">INVENTORY</label><select class="input" id="sj-finv">' +
        opt('', 'All', s.fInv) + opt('NOT ASSIGNED', 'Not assigned', s.fInv) +
        opt('PARTIAL', 'Partial', s.fInv) + opt('COMPLETE', 'Complete', s.fInv) + '</select></div>' +
    '</div>' +
    (s.tab === 'COMPLETED'
      ? '<div class="frow"><div class="field"><label class="label">FROM</label><input class="input" type="date" id="sj-dfrom" value="' + esc(s.dateFrom) + '"></div>' +
        '<div class="field"><label class="label">TO</label><input class="input" type="date" id="sj-dto" value="' + esc(s.dateTo) + '"></div></div>'
      : '') +
    '</div>' +
    '<div id="sj-body"><p class="hint center">Loading jobs…</p></div>' +
    '</div>';
  return { html: html, mount: function () {
    function paint() {
      var st = sjState(), today = warehouseToday();
      var list = sjFiltered();
      var counts = sjTabCounts();
      Array.prototype.forEach.call(document.querySelectorAll('[data-badge]'), function (b) {
        b.textContent = counts[b.getAttribute('data-badge')] || 0;
      });
      var body = $('#sj-body');
      if (!list.length) {
        body.innerHTML = '<p class="hint center">No jobs in this view.</p>';
        return;
      }
      if (st.tab === 'UPCOMING') {
        /* Group by date: TOMORROW / weekday / NEXT WEEK. */
        var groups = {};
        list.forEach(function (w) {
          var g = sjGroupLabel(w.scheduledDate, today);
          (groups[g] = groups[g] || []).push(w);
        });
        body.innerHTML = Object.keys(groups).map(function (g) {
          return '<div class="sect">' + esc(g) + '</div>' +
            groups[g].map(sjJobCard).join('');
        }).join('');
      } else {
        body.innerHTML = list.map(sjJobCard).join('');
      }
      Array.prototype.forEach.call(body.querySelectorAll('[data-qa]'), function (b) {
        b.onclick = function (e) {
          e.stopPropagation();
          var w = woById(b.getAttribute('data-qa'));
          if (w) go(jobQuickAction(w).route);
        };
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-detail]'), function (b) {
        b.onclick = function (e) { e.stopPropagation(); go('scheduled-job/' + b.getAttribute('data-detail')); };
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-job]'), function (c) {
        c.onclick = function () { go('scheduled-job/' + c.getAttribute('data-job')); };
      });
      Array.prototype.forEach.call(body.querySelectorAll('[data-roll]'), function (b) {
        b.onclick = function (e) { e.stopPropagation(); go('roll/' + b.getAttribute('data-roll')); };
      });
    }
    function reload() {
      $('#sj-body').innerHTML = '<p class="hint center">Loading jobs…</p>';
      Repository.getScheduledJobs().then(function (jobs) {
        sjState().jobs = jobs; paint();
      }).catch(function (err) {
        $('#sj-body').innerHTML = '<div class="err center">' + esc((err && err.message) || 'Could not load jobs.') + '</div>';
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { sjState().tab = b.getAttribute('data-tab'); render(); };
    });
    var myB = document.querySelector('[data-my]');
    if (myB) myB.onclick = function () { sjState().my = !sjState().my; render(); };
    var unB = document.querySelector('[data-un]');
    if (unB) unB.onclick = function () { sjState().unassigned = !sjState().unassigned; render(); };
    $('#sj-refresh').onclick = function () {
      Repository.refresh().then(reload).catch(reload);
    };
    var q = $('#sj-q');
    var qt = null;
    q.oninput = function () { clearTimeout(qt); qt = setTimeout(function () { sjState().q = q.value; paint(); }, 250); };
    $('#sj-fstatus').onchange = function (e) { sjState().fStatus = e.target.value; paint(); };
    $('#sj-fpri').onchange = function (e) { sjState().fPriority = e.target.value; paint(); };
    $('#sj-femp').onchange = function (e) { sjState().fEmployee = e.target.value; paint(); };
    $('#sj-fprop').onchange = function (e) { sjState().fProperty = e.target.value; paint(); };
    $('#sj-finv').onchange = function (e) { sjState().fInv = e.target.value; paint(); };
    $('#sj-sort').onchange = function (e) { sjState().sort = e.target.value; paint(); };
    var df = $('#sj-dfrom'), dt = $('#sj-dto');
    if (df) df.onchange = function (e) { sjState().dateFrom = e.target.value; paint(); };
    if (dt) dt.onchange = function (e) { sjState().dateTo = e.target.value; paint(); };
    reload();
  }};
};

/* Job detail: scheduling-focused view of one work order. Reuses the Work
   Order record — no duplicate job database. */
Screens['scheduled-job'] = function (param) {
  var w = woById(param);
  if (!w) { setTimeout(function () { go('scheduled-jobs'); }, 0); return { html: '' }; }
  var r = jobReadiness(w);
  var step = currentWarehouseStep(w);
  var cs = woCutStatus(w);
  var emp = woAssigneeName(w);
  var isSup = isSupervisorRole(DB.data.currentEmployee);
  var notes = woNotes(w);
  var evts = assignEventsForWO(w.id);
  var blockers = warehouseCompletionBlockers(w);
  var qa = jobQuickAction(w);
  var linesHtml = (w.lines || []).map(function (l) {
    var lp = lineProgress(w, l);
    var cls = lp === 'CUT COMPLETE' ? 'st-green' : (lp === 'WAITING FOR INVENTORY' ? 'st-yellow' : 'st-blue');
    var act = activeAssignments(w.id, l.id);
    var lineAction = lp === 'WAITING FOR INVENTORY' || lp === 'INVENTORY ASSIGNED'
      ? '<button class="btn btn-small" data-lineassign="' + esc(l.id) + '">ASSIGN INVENTORY</button>'
      : (act.length === 1 ? '<button class="btn btn-small btn-primary" data-linecut="' + esc(act[0].id) + '">CONTINUE TO CUT</button>' : '');
    return '<div class="card"><div class="rhead"><b>' + esc(l.style || '') + ' / ' + esc(l.color || '') + '</b> ' +
      '<span class="stchip ' + cls + '">' + (lp === 'CUT COMPLETE' ? '✓ ' : '') + esc(lp) + '</span></div>' +
      '<div class="sub">' + esc(l.materialType || '') + ' · required <b class="num">' + fmtLen(l.requiredIn || 0) + '</b></div>' +
      (lineAction ? '<div class="btn-row">' + lineAction + '</div>' : '') + '</div>';
  }).join('');
  var asnHtml = (function () {
    var recs = [];
    (w.lines || []).forEach(function (l) {
      allAssignmentsForLine(w.id, l.id).forEach(function (a) {
        if (a.status === AI_STATUS.RESERVED) recs.push({ a: a, line: l });
      });
    });
    if (!recs.length) return '<p class="hint">No inventory assigned yet.</p>';
    return recs.map(function (x) {
      var roll = rollById(x.a.rollId);
      var loc = (roll && roll.expectedLocation) || x.a.location || '—';
      return '<div class="trow"><div><b class="mono">' + esc(x.a.rollId) + '</b>' +
        '<div class="sub">' + esc(x.line.style || '') + ' · reserved <b class="num">' + fmtLen(x.a.reservedIn || 0) + '</b> · loc ' + esc(loc) + '</div></div>' +
        '<div><button class="btn btn-small" data-roll="' + esc(x.a.rollId) + '">VIEW ROLL</button></div></div>';
    }).join('');
  })();
  var cutsHtml = cs.cuts.length ? cs.cuts.map(function (c) {
    return '<div class="trow"><div><b class="mono">' + esc(c.rollId) + '</b>' +
      '<div class="sub">cut <b class="num">' + fmtLen(c.inches) + '</b> · ' + esc(c.by) + ' · ' + fmtDT(c.at) + '</div></div></div>';
  }).join('') : '<p class="hint">No cuts recorded yet.</p>';
  var notesHtml = notes.length ? notes.map(function (n) {
    return '<div class="trow"><div>' + esc(n.detail) + '</div><div class="sub">' + esc(n.user) + '<br>' + fmtDT(n.at) + '</div></div>';
  }).join('') : '<p class="hint">No notes yet.</p>';
  var actHtml = evts.length ? evts.map(function (e) {
    return '<div class="trow"><div><b>' + esc(aiEventLabel(e.action)) + '</b>' +
      (e.rollId ? ' <span class="mono">' + esc(e.rollId) + '</span>' : '') +
      (e.detail ? '<div class="sub">' + esc(e.detail) + '</div>' : '') + '</div>' +
      '<div class="sub">' + esc(e.user) + '<br>' + fmtDT(e.at) + '</div></div>';
  }).join('') : '<p class="hint">No activity yet.</p>';
  var sched = w.scheduledDate ? sjFmtDate(w.scheduledDate) + (w.scheduledTime ? ' · ' + esc(w.scheduledTime) : '') : 'Not scheduled';
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">← SCHEDULED JOBS</button>' +
    '<div class="step-head">SCHEDULED JOB</div>' +
    '<h1 class="mono">' + esc(w.number) + '</h1>' +
    '<div>' + sjPriorityChip(w.priority) + ' ' + sjReadinessChip(r) + '</div>' +
    (w.onHold ? '<div class="warn-panel"><div class="big-ok">⏸ ON HOLD</div><p class="hint">' + esc(w.holdReason || '') +
      (w.holdBy ? ' · by ' + esc(w.holdBy) : '') + '</p></div>' : '') +
    '<div class="card">' +
      '<div class="kv"><span class="k">Scheduled</span><span class="v num">' + sched + '</span></div>' +
      '<div class="kv"><span class="k">Property</span><span class="v">' + esc(w.property) + '</span></div>' +
      '<div class="kv"><span class="k">Account</span><span class="v">' + esc(w.account) + '</span></div>' +
      '<div class="kv"><span class="k">Employee</span><span class="v">' + (emp ? '<b>' + esc(emp) + '</b>' : '<span class="stchip st-yellow">UNASSIGNED</span>') + '</span></div>' +
      '<div class="kv"><span class="k">Current step</span><span class="v"><b>' + esc(step.replace(/_/g, ' ')) + '</b></span></div>' +
      '<div class="kv"><span class="k">Cut status</span><span class="v">' + esc(cs.state) +
        (cs.cutIn ? ' · <b class="num">' + fmtLen(cs.cutIn) + '</b>' : '') + '</span></div>' +
      (w.warehouseCompletedAt ? '<div class="kv"><span class="k">Completed</span><span class="v">' + esc(w.warehouseCompletedBy || '') + ' · ' + fmtDT(w.warehouseCompletedAt) + '</span></div>' : '') +
    '</div>' +
    '<div class="btn-row"><button class="btn btn-primary" id="sj-qa" style="flex:1">' + esc(qa.label) + '</button>' +
    '<button class="btn" id="sj-wo">WORK ORDER</button></div>' +
    '<h2>Material lines</h2>' + (linesHtml || '<p class="hint">No material lines.</p>') +
    '<h2>Inventory assignments</h2><div class="card">' + asnHtml + '</div>' +
    '<h2>Cut status</h2><div class="card">' + cutsHtml + '</div>' +
    '<h2>Actions</h2><div class="card">' +
      '<div class="btn-row">' +
      (w.opStatus !== 'IN_PROGRESS' && r !== JOB_STATES.COMPLETED ? '<button class="btn" id="sj-start" style="flex:1">▶ START WORK</button>' : '') +
      (isSup && !w.onHold && r !== JOB_STATES.COMPLETED ? '<button class="btn" id="sj-hold" style="flex:1">⏸ HOLD</button>' : '') +
      (isSup && w.onHold ? '<button class="btn btn-primary" id="sj-resume" style="flex:1">▶ RESUME JOB</button>' : '') +
      '</div>' +
      (isSup ? '<div class="field"><label class="label" for="sj-emp">ASSIGN EMPLOYEE</label><div class="frow">' +
        '<select class="input" id="sj-emp" style="flex:1"><option value="">— unassigned —</option>' +
        DB.data.employees.map(function (e, i) {
          var eid = 'e' + (i + 1);
          return '<option value="' + eid + '"' + (w.assigneeId === eid ? ' selected' : '') + '>' + esc(e) + '</option>';
        }).join('') + '</select>' +
        '<button class="btn btn-primary" id="sj-assign">SAVE</button></div></div>' : '') +
      (isSup && r !== JOB_STATES.COMPLETED
        ? '<button class="btn btn-primary btn-huge" id="sj-complete">✔ COMPLETE WAREHOUSE WORK</button>' +
          (blockers.length ? '<p class="hint">Blocked: ' + blockers.map(function (b) {
              return esc(b.lineId) + ' (' + esc(b.status) + ')';
            }).join(', ') + '</p>' : '<p class="hint">All material lines complete — ready to close out.</p>')
        : '') +
      (!isSup && isWoAssignee(w) && r !== JOB_STATES.COMPLETED
        ? '<button class="btn btn-primary btn-huge" id="sj-complete">✔ COMPLETE MY JOB</button>' +
          (blockers.length ? '<p class="hint">Blocked: ' + blockers.map(function (b) {
              return esc(b.lineId) + ' (' + esc(b.status) + ')';
            }).join(', ') + '</p>' : '<p class="hint">All material lines complete — ready to close out.</p>')
        : '') +
      (isSup && r === JOB_STATES.COMPLETED
        ? '<button class="btn" id="sj-reopen" style="flex:1">↩ REOPEN JOB</button>'
        : '') +
    '</div>' +
    '<h2>Notes</h2><div class="card">' + notesHtml +
      '<div class="field"><label class="label" for="sj-note">ADD NOTE</label>' +
      '<div class="frow"><input class="input" id="sj-note" style="flex:1" placeholder="Warehouse note…">' +
      '<button class="btn btn-primary" id="sj-addnote">ADD</button></div></div></div>' +
    '<h2>Activity</h2><div class="card">' + actHtml + '</div>' +
    '</div>';
  return { html: html, mount: function () {
    function afterMutation(p, okMsg) {
      return p.then(function (res) {
        if (!res || res.ok === false) { bad(); toast((res && res.err) || 'Action failed.'); return; }
        good(); if (okMsg) toast(okMsg);
        return Repository.refresh({ quiet: true }).catch(function () {}).then(render);
      }).catch(function (err) {
        bad();
        toast((err && err.code === 'OFFLINE') ? 'OFFLINE — not synced. Will not pretend success.' : ((err && err.message) || 'Action failed.'));
      });
    }
    $('#back').onclick = function () { go('scheduled-jobs', sjState().tab); };
    $('#sj-qa').onclick = function () { go(qa.route); };
    $('#sj-wo').onclick = function () { go('work-order/' + w.id); };
    var st = $('#sj-start');
    if (st) st.onclick = function () { afterMutation(Repository.startWarehouseWork(w.id), 'Work started.'); };
    var hd = $('#sj-hold');
    if (hd) hd.onclick = function () {
      var reasons = ['MATERIAL NOT FOUND', 'INSUFFICIENT MATERIAL', 'ORDER ISSUE', 'MANAGER REVIEW', 'OTHER'];
      var wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h2>Hold ' + esc(w.number) + '?</h2>' +
        '<div class="field"><label class="label">REASON (required)</label><select class="input" id="hold-reason">' +
        reasons.map(function (x) { return '<option>' + x + '</option>'; }).join('') + '</select></div>' +
        '<button class="btn btn-primary" id="hold-ok">PLACE ON HOLD</button> ' +
        '<button class="btn" id="hold-cancel">CANCEL</button></div>';
      document.body.appendChild(wrap);
      wrap.querySelector('#hold-cancel').onclick = function () { wrap.remove(); };
      wrap.querySelector('#hold-ok').onclick = function () {
        var reason = wrap.querySelector('#hold-reason').value;
        wrap.remove();
        afterMutation(Repository.setJobHold(w.id, reason), 'Job placed on hold.');
      };
    };
    var rs = $('#sj-resume');
    if (rs) rs.onclick = function () { afterMutation(Repository.resumeJob(w.id), 'Job resumed.'); };
    var as = $('#sj-assign');
    if (as) as.onclick = function () {
      afterMutation(Repository.assignEmployee(w.id, $('#sj-emp').value || null), 'Assignment saved.');
    };
    var cp = $('#sj-complete');
    if (cp) cp.onclick = function () {
      showConfirm({ title: 'Complete warehouse work for ' + w.number + '?',
        body: 'All material lines are complete. This closes the warehouse job.',
        okLabel: 'COMPLETE' }).then(function (ok) {
        if (ok) afterMutation(Repository.completeWarehouseWork(w.id), 'Warehouse work completed.');
      });
    };
    var ro = $('#sj-reopen');
    if (ro) ro.onclick = function () {
      var wrap = document.createElement('div');
      wrap.className = 'modal-wrap';
      wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h2>Reopen ' + esc(w.number) + '?</h2>' +
        '<div class="field"><label class="label">REASON (required)</label>' +
        '<input class="input" id="reopen-reason" placeholder="Why is this job being reopened?"></div>' +
        '<button class="btn btn-primary" id="reopen-ok">REOPEN JOB</button> ' +
        '<button class="btn" id="reopen-cancel">CANCEL</button></div>';
      document.body.appendChild(wrap);
      wrap.querySelector('#reopen-cancel').onclick = function () { wrap.remove(); };
      wrap.querySelector('#reopen-ok').onclick = function () {
        var reason = wrap.querySelector('#reopen-reason').value;
        wrap.remove();
        afterMutation(Repository.reopenWarehouseWork(w.id, reason), 'Job reopened.');
      };
    };
    $('#sj-addnote').onclick = function () {
      var t = $('#sj-note').value;
      afterMutation(Repository.addWorkOrderNote(w.id, t), 'Note added.');
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-roll]'), function (b) {
      b.onclick = function () { go('roll/' + b.getAttribute('data-roll')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-lineassign]'), function (b) {
      b.onclick = function () { go('assign-inventory/wo/' + w.id); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-linecut]'), function (b) {
      b.onclick = function () { go('assign-inventory/a/' + b.getAttribute('data-linecut')); };
    });
  }};
};

/* ======================================================================
   RUN 6: ORDER + SALES ORDER foundation.
   Commercial layer upstream of warehouse execution:
     ORDER -> SALES ORDER -> WORK ORDER(S) -> ASSIGN INVENTORY -> ROLL -> CUT
   Rules:
   - Orders are drafts (DRAFT -> READY_FOR_REVIEW -> SUBMITTED -> sales order).
   - No pricing/accounting/payment logic. No duplicate material data:
     sales-order lines carry the submitted values plus a sourceItemId link.
   - Submission and line release are idempotent (safe double-tap / retry).
   - Role policy is centralized in orderPolicy() below.
   ====================================================================== */

var ORDER_STATUS = { DRAFT: 'DRAFT', READY_FOR_REVIEW: 'READY_FOR_REVIEW', SUBMITTED: 'SUBMITTED', CANCELLED: 'CANCELLED' };
var SO_STATUS = { OPEN: 'OPEN', PARTIALLY_RELEASED: 'PARTIALLY_RELEASED', RELEASED_TO_WAREHOUSE: 'RELEASED_TO_WAREHOUSE',
  IN_PROGRESS: 'IN_PROGRESS', COMPLETED: 'COMPLETED', ON_HOLD: 'ON_HOLD', CANCELLED: 'CANCELLED' };
var ORDER_MATERIAL_TYPES = ['CARPET', 'PLANK', 'PAD', 'OTHER'];
var ORDER_UOMS = ['LF', 'BOX', 'EA', 'ROLL', 'SY'];

/* Prototype role policy for the order commercial layer. Centralized and
   configurable — the single place Run 7+ adjusts when rules firm up. */
function orderPolicy() {
  var role = (DB.data && DB.data.employeeRoles && DB.data.currentEmployee)
    ? (DB.data.employeeRoles[DB.data.currentEmployee] || '') : '';
  var mgr = role === 'MANAGER' || role === 'ADMIN';
  var sup = mgr || role === 'SUPERVISOR';
  return {
    role: role,
    canCreateOrder: mgr,          /* start / edit drafts, add items */
    canMarkReady: mgr,            /* DRAFT -> READY_FOR_REVIEW */
    canSubmitOrder: mgr,          /* -> SALES ORDER (atomic) */
    canReleaseLine: sup,          /* release eligible warehouse lines */
    canHoldSalesOrder: mgr,       /* hold / resume */
    canCancelSalesOrder: mgr,     /* cancel where safe */
    canReopenWarehouseJob: sup    /* Run 6 §0: reopen completed warehouse job */
  };
}
function orderPolicyRequire(ok, err) {
  if (!ok) return { ok: false, err: err || 'NOT AUTHORIZED FOR THIS ACTION' };
  return null;
}

function nextOrderNumber() { var s = FG().seq || (FG().seq = {}); s.order = s.order || 1002; return 'ORD-' + (s.order++); }
function nextSalesOrderNumber() { var s = FG().seq || (FG().seq = {}); s.salesOrder = s.salesOrder || 100246; return 'SO-' + (s.salesOrder++); }
function nextGeneratedWoNumber() { var s = FG().seq || (FG().seq = {}); s.workOrder = s.workOrder || 2001; return 'WO-' + (s.workOrder++); }

function orderById(id) {
  return ((FG() && FG().orders) || []).filter(function (o) { return o.id === id; })[0] || null;
}
function salesOrderById(id) {
  return ((FG() && FG().salesOrders) || []).filter(function (s) { return s.id === id; })[0] || null;
}
function salesOrderByNumber(num) {
  var n = String(num || '').toUpperCase();
  return ((FG() && FG().salesOrders) || []).filter(function (s) { return String(s.number || '').toUpperCase() === n; })[0] || null;
}
function orderByNumber(num) {
  var n = String(num || '').toUpperCase();
  return ((FG() && FG().orders) || []).filter(function (o) { return String(o.number || '').toUpperCase() === n; })[0] || null;
}
function orderEditable(o) {
  return o && (o.status === ORDER_STATUS.DRAFT || o.status === ORDER_STATUS.READY_FOR_REVIEW);
}
function orderItemById(o, itemId) {
  return ((o && o.items) || []).filter(function (i) { return i.id === itemId; })[0] || null;
}
function soLineById(so, lineId) {
  return ((so && so.lines) || []).filter(function (l) { return l.id === lineId; })[0] || null;
}

/* Append-only audit for the commercial layer. */
function logOrderEvent(action, o) {
  o = o || {};
  FG().orderEvents.push({
    id: rid('OE'), at: new Date().toISOString(),
    action: action, user: o.user || (DB.data && DB.data.currentEmployee) || '',
    warehouse: o.warehouse || (DB.data && DB.data.currentWarehouse) || '',
    orderId: o.orderId || null, orderNumber: o.orderNumber || null,
    salesOrderId: o.salesOrderId || null, salesOrderNumber: o.salesOrderNumber || null,
    workOrderId: o.workOrderId || null, detail: o.detail || ''
  });
  DB.save();
}
function orderEventsFor(o) {
  o = o || {};
  return ((FG() && FG().orderEvents) || []).filter(function (e) {
    return (o.orderId && e.orderId === o.orderId) || (o.salesOrderId && e.salesOrderId === o.salesOrderId);
  }).sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
}
var ORDER_EVENT_LABELS = {
  ORDER_CREATED: 'ORDER CREATED', ORDER_HEADER_UPDATED: 'HEADER UPDATED',
  ORDER_ITEM_ADDED: 'ITEM ADDED', ORDER_ITEM_UPDATED: 'ITEM UPDATED',
  ORDER_ITEM_REMOVED: 'ITEM REMOVED', ORDER_MARKED_READY: 'MARKED READY FOR REVIEW',
  ORDER_SUBMITTED: 'ORDER SUBMITTED', SALES_ORDER_CREATED: 'SALES ORDER CREATED',
  SALES_ORDER_LINE_RELEASED: 'LINE RELEASED TO WAREHOUSE',
  WORK_ORDER_GENERATED: 'WORK ORDER GENERATED',
  SALES_ORDER_HELD: 'SALES ORDER ON HOLD', SALES_ORDER_RESUMED: 'SALES ORDER RESUMED',
  SALES_ORDER_CANCELLED: 'SALES ORDER CANCELLED'
};

/* ---- Order header ---- */
function validateOrderHeader(h) {
  h = h || {};
  if (!String(h.property || '').trim()) return 'PROPERTY IS REQUIRED';
  if (h.priority && ['LOW', 'NORMAL', 'HIGH', 'URGENT'].indexOf(h.priority) < 0) return 'INVALID PRIORITY';
  return null;
}
function createOrderLocal(h) {
  var pol = orderPolicyRequire(orderPolicy().canCreateOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  h = h || {};
  var err = validateOrderHeader(h);
  if (err) return { ok: false, err: err };
  var now = new Date().toISOString();
  var o = {
    id: rid('ORD'), number: nextOrderNumber(),
    property: String(h.property).trim(),
    account: String(h.account || accountForProperty(h.property) || '').trim(),
    requestedDate: h.requestedDate || null, scheduledDate: h.scheduledDate || null,
    priority: h.priority || 'NORMAL',
    createdBy: DB.data.currentEmployee, warehouseId: DB.data.currentWarehouse,
    internalRef: String(h.internalRef || '').trim(), notes: String(h.notes || '').trim(),
    status: ORDER_STATUS.DRAFT, items: [],
    createdAt: now, updatedAt: now, submittedAt: null, salesOrderId: null
  };
  FG().orders.push(o);
  DB.save();
  logOrderEvent('ORDER_CREATED', { orderId: o.id, orderNumber: o.number,
    detail: o.property + (o.account ? ' · ' + o.account : '') });
  return { ok: true, order: o };
}
function updateOrderHeaderLocal(orderId, patch) {
  var pol = orderPolicyRequire(orderPolicy().canCreateOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var o = orderById(orderId);
  if (!o) return { ok: false, err: 'ORDER NOT FOUND' };
  if (!orderEditable(o)) return { ok: false, err: 'ORDER IS NOT EDITABLE' };
  var merged = { property: o.property, account: o.account, requestedDate: o.requestedDate,
    scheduledDate: o.scheduledDate, priority: o.priority, internalRef: o.internalRef, notes: o.notes };
  ['property', 'account', 'requestedDate', 'scheduledDate', 'priority', 'internalRef', 'notes'].forEach(function (k) {
    if (patch && k in patch) merged[k] = patch[k];
  });
  var err = validateOrderHeader(merged);
  if (err) return { ok: false, err: err };
  o.property = String(merged.property).trim(); o.account = String(merged.account || '').trim();
  o.requestedDate = merged.requestedDate || null; o.scheduledDate = merged.scheduledDate || null;
  o.priority = merged.priority || 'NORMAL';
  o.internalRef = String(merged.internalRef || '').trim(); o.notes = String(merged.notes || '').trim();
  o.updatedAt = new Date().toISOString();
  DB.save();
  logOrderEvent('ORDER_HEADER_UPDATED', { orderId: o.id, orderNumber: o.number });
  return { ok: true, order: o };
}

/* ---- Order items ---- */
function validateOrderItem(it) {
  it = it || {};
  if (!String(it.style || '').trim()) return 'STYLE / PRODUCT IS REQUIRED';
  if (ORDER_MATERIAL_TYPES.indexOf(it.materialType) < 0) return 'INVALID MATERIAL TYPE';
  if (ORDER_UOMS.indexOf(it.uom) < 0) return 'INVALID UOM';
  if (it.uom === 'LF') {
    var inches = Math.round(Number(it.quantityIn));
    if (!isFinite(inches) || inches <= 0) return 'CARPET QUANTITY MUST BE A POSITIVE LENGTH';
  } else {
    var q = Number(it.quantity);
    if (!isFinite(q) || q <= 0) return 'QUANTITY MUST BE POSITIVE';
  }
  return null;
}
function addOrderItemLocal(orderId, it) {
  var pol = orderPolicyRequire(orderPolicy().canCreateOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var o = orderById(orderId);
  if (!o) return { ok: false, err: 'ORDER NOT FOUND' };
  if (!orderEditable(o)) return { ok: false, err: 'ORDER IS NOT EDITABLE' };
  it = it || {};
  var err = validateOrderItem(it);
  if (err) return { ok: false, err: err };
  var rec = {
    id: rid('OI'), seq: (o.items || []).length + 1,
    style: String(it.style).trim(), color: String(it.color || '').trim(),
    materialType: it.materialType, uom: it.uom,
    widthIn: it.widthIn != null && it.widthIn !== '' ? Math.round(Number(it.widthIn)) : null,
    /* ORDER QUANTITY = requested material. Carpet: integer inches.
       ROLL BALANCE = warehouse inventory — never mixed. */
    quantityIn: it.uom === 'LF' ? Math.round(Number(it.quantityIn)) : null,
    quantity: it.uom === 'LF' ? null : Number(it.quantity),
    notes: String(it.notes || '').trim()
  };
  o.items.push(rec);
  o.updatedAt = new Date().toISOString();
  DB.save();
  logOrderEvent('ORDER_ITEM_ADDED', { orderId: o.id, orderNumber: o.number,
    detail: rec.style + (rec.color ? ' / ' + rec.color : '') + ' · ' + orderItemQtyDisplay(rec) });
  return { ok: true, order: o, item: rec };
}
function updateOrderItemLocal(orderId, itemId, patch) {
  var pol = orderPolicyRequire(orderPolicy().canCreateOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var o = orderById(orderId);
  if (!o) return { ok: false, err: 'ORDER NOT FOUND' };
  if (!orderEditable(o)) return { ok: false, err: 'ORDER IS NOT EDITABLE' };
  var rec = orderItemById(o, itemId);
  if (!rec) return { ok: false, err: 'ITEM NOT FOUND' };
  var merged = { style: rec.style, color: rec.color, materialType: rec.materialType, uom: rec.uom,
    widthIn: rec.widthIn, quantityIn: rec.quantityIn, quantity: rec.quantity, notes: rec.notes };
  ['style', 'color', 'materialType', 'uom', 'widthIn', 'quantityIn', 'quantity', 'notes'].forEach(function (k) {
    if (patch && k in patch) merged[k] = patch[k];
  });
  var err = validateOrderItem(merged);
  if (err) return { ok: false, err: err };
  rec.style = String(merged.style).trim(); rec.color = String(merged.color || '').trim();
  rec.materialType = merged.materialType; rec.uom = merged.uom;
  rec.widthIn = merged.widthIn != null && merged.widthIn !== '' ? Math.round(Number(merged.widthIn)) : null;
  rec.quantityIn = merged.uom === 'LF' ? Math.round(Number(merged.quantityIn)) : null;
  rec.quantity = merged.uom === 'LF' ? null : Number(merged.quantity);
  rec.notes = String(merged.notes || '').trim();
  o.updatedAt = new Date().toISOString();
  DB.save();
  logOrderEvent('ORDER_ITEM_UPDATED', { orderId: o.id, orderNumber: o.number, detail: 'Line ' + rec.seq + ': ' + rec.style });
  return { ok: true, order: o, item: rec };
}
function removeOrderItemLocal(orderId, itemId) {
  var pol = orderPolicyRequire(orderPolicy().canCreateOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var o = orderById(orderId);
  if (!o) return { ok: false, err: 'ORDER NOT FOUND' };
  if (!orderEditable(o)) return { ok: false, err: 'ORDER IS NOT EDITABLE' };
  var idx = (o.items || []).map(function (i) { return i.id; }).indexOf(itemId);
  if (idx < 0) return { ok: false, err: 'ITEM NOT FOUND' };
  var removed = o.items.splice(idx, 1)[0];
  o.items.forEach(function (i, n) { i.seq = n + 1; });
  o.updatedAt = new Date().toISOString();
  DB.save();
  logOrderEvent('ORDER_ITEM_REMOVED', { orderId: o.id, orderNumber: o.number, detail: 'Line removed: ' + removed.style });
  return { ok: true, order: o };
}
/* Discard a draft order. Only unsubmitted drafts may be discarded — a
   submitted order has commercial meaning and must be cancelled through
   its sales order instead. Runs through the repository (never direct
   FG() mutation from the UI) so shared drafts are deleted server-side. */
function deleteOrderLocal(id) {
  var pol = orderPolicyRequire(orderPolicy().canCreateOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var o = orderById(id);
  if (!o) return { ok: false, err: 'ORDER NOT FOUND' };
  if (o.status !== ORDER_STATUS.DRAFT && o.status !== ORDER_STATUS.READY_FOR_REVIEW)
    return { ok: false, err: 'ONLY DRAFTS CAN BE DISCARDED' };
  FG().orders = (FG().orders || []).filter(function (x) { return x.id !== id; });
  DB.save();
  logOrderEvent('ORDER_DISCARDED', { orderId: id, orderNumber: o.number,
    detail: 'Draft ' + o.number + ' discarded by ' + DB.data.currentEmployee + '.' });
  return { ok: true };
}
function orderItemQtyDisplay(it) {
  if (!it) return '';
  /* Order items carry quantityIn/quantity; sales-order lines carry
     orderedIn/orderedQty/warehouseQtyRequired. Both shapes render. */
  if (it.uom === 'LF') {
    var inches = it.quantityIn != null ? it.quantityIn
      : (it.warehouseQtyRequired != null ? it.warehouseQtyRequired : it.orderedIn);
    return fmtLen(inches || 0) + ' LF';
  }
  var qty = it.quantity != null ? it.quantity
    : (it.warehouseQtyRequired != null ? it.warehouseQtyRequired : it.orderedQty);
  return String(qty) + ' ' + it.uom;
}

/* ---- Draft lists ---- */
function getDraftOrdersLocal() {
  return (FG().orders || [])
    .filter(function (o) { return o.status === ORDER_STATUS.DRAFT || o.status === ORDER_STATUS.READY_FOR_REVIEW; })
    .sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
}
function getRecentSubmittedOrdersLocal(limit) {
  return (FG().orders || [])
    .filter(function (o) { return o.status === ORDER_STATUS.SUBMITTED; })
    .sort(function (a, b) { return new Date(b.submittedAt || b.updatedAt) - new Date(a.submittedAt || a.updatedAt); })
    .slice(0, limit || 5);
}

/* ---- Review -> submit ---- */
function markOrderReadyLocal(orderId) {
  var pol = orderPolicyRequire(orderPolicy().canMarkReady, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var o = orderById(orderId);
  if (!o) return { ok: false, err: 'ORDER NOT FOUND' };
  if (o.status !== ORDER_STATUS.DRAFT) return { ok: false, err: 'ORDER IS NOT A DRAFT' };
  if (!(o.items || []).length) return { ok: false, err: 'ADD AT LEAST ONE ITEM' };
  o.status = ORDER_STATUS.READY_FOR_REVIEW;
  o.updatedAt = new Date().toISOString();
  DB.save();
  logOrderEvent('ORDER_MARKED_READY', { orderId: o.id, orderNumber: o.number });
  return { ok: true, order: o };
}

/* Atomic submit: DRAFT/REVIEW -> SALES ORDER + lines in one step.
   Idempotent: a retry on an already-submitted order returns the existing
   sales order (duplicate:true) instead of creating a second one. */
function submitOrderLocal(orderId) {
  var pol = orderPolicyRequire(orderPolicy().canSubmitOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var o = orderById(orderId);
  if (!o) return { ok: false, err: 'ORDER NOT FOUND' };
  if (o.status === ORDER_STATUS.SUBMITTED && o.salesOrderId) {
    var existing = salesOrderById(o.salesOrderId);
    if (existing) return { ok: true, salesOrder: existing, order: o, duplicate: true };
  }
  if (!orderEditable(o)) return { ok: false, err: 'ORDER IS NOT SUBMITTABLE' };
  if (!(o.items || []).length) return { ok: false, err: 'ADD AT LEAST ONE ITEM' };
  var now = new Date().toISOString();
  /* Build the full sales-order record first; only commit when every line
     validates — no partial sales order is ever persisted. */
  var lines = [];
  for (var i = 0; i < o.items.length; i++) {
    var it = o.items[i];
    var err = validateOrderItem(it);
    if (err) return { ok: false, err: 'LINE ' + it.seq + ': ' + err };
    lines.push({
      id: rid('SOL'), seq: it.seq, sourceItemId: it.id,
      style: it.style, color: it.color, materialType: it.materialType, uom: it.uom,
      widthIn: it.widthIn,
      orderedIn: it.quantityIn, orderedQty: it.quantity,
      warehouseQtyRequired: it.quantityIn != null ? it.quantityIn : it.quantity,
      status: 'OPEN', workOrderId: null
    });
  }
  var so = {
    id: rid('SO'), number: nextSalesOrderNumber(), sourceOrderId: o.id,
    property: o.property, account: o.account, warehouseId: o.warehouseId,
    priority: o.priority, requestedDate: o.requestedDate, scheduledDate: o.scheduledDate,
    status: SO_STATUS.OPEN, createdBy: o.createdBy, submittedBy: DB.data.currentEmployee,
    createdAt: now, submittedAt: now, updatedAt: now, notes: o.notes,
    onHold: false, holdReason: null, holdAt: null, holdBy: null,
    lines: lines
  };
  FG().salesOrders.push(so);
  o.status = ORDER_STATUS.SUBMITTED; o.submittedAt = now; o.updatedAt = now; o.salesOrderId = so.id;
  DB.save();
  logOrderEvent('ORDER_SUBMITTED', { orderId: o.id, orderNumber: o.number,
    salesOrderId: so.id, salesOrderNumber: so.number, detail: 'Converted to sales order.' });
  logOrderEvent('SALES_ORDER_CREATED', { orderId: o.id, orderNumber: o.number,
    salesOrderId: so.id, salesOrderNumber: so.number,
    detail: lines.length + ' material line(s).' });
  return { ok: true, salesOrder: so, order: o };
}

/* ---- Sales order reads ---- */
/* Warehouse status derives from released lines + generated work orders —
   never maintained by hand where derivation is reliable. */
function salesOrderWarehouseStatus(so) {
  if (!so) return '';
  if (so.status === SO_STATUS.ON_HOLD) return SO_STATUS.ON_HOLD;
  if (so.status === SO_STATUS.CANCELLED) return SO_STATUS.CANCELLED;
  var lines = so.lines || [];
  var released = lines.filter(function (l) { return l.status === 'RELEASED'; });
  if (!released.length) return SO_STATUS.OPEN;
  var wos = released.map(function (l) { return l.workOrderId && woById(l.workOrderId); })
    .filter(Boolean);
  if (wos.length && wos.every(function (w) { return w.opStatus === 'COMPLETE'; }) && wos.length === released.length)
    return SO_STATUS.COMPLETED;
  if (wos.some(function (w) { return w.opStatus === 'IN_PROGRESS'; })) return SO_STATUS.IN_PROGRESS;
  if (released.length < lines.length) return SO_STATUS.PARTIALLY_RELEASED;
  return SO_STATUS.RELEASED_TO_WAREHOUSE;
}
function getSalesOrdersLocal() {
  return (FG().salesOrders || [])
    .slice().sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
}
function salesOrdersByTab(tab) {
  var all = getSalesOrdersLocal();
  var key = String(tab || '').replace(/ /g, '_');
  return all.filter(function (so) {
    var st = salesOrderWarehouseStatus(so);
    if (key === 'OPEN') return st === SO_STATUS.OPEN || st === SO_STATUS.PARTIALLY_RELEASED;
    if (key === 'RELEASED') return st === SO_STATUS.RELEASED_TO_WAREHOUSE;
    if (key === 'IN_PROGRESS') return st === SO_STATUS.IN_PROGRESS;
    if (key === 'COMPLETED') return st === SO_STATUS.COMPLETED;
    if (key === 'ON_HOLD') return st === SO_STATUS.ON_HOLD;
    return true;
  });
}

/* ---- Release to warehouse ----
   One eligible sales-order material line -> one work order (Run 6 rule;
   generation logic is isolated here so company grouping rules can change).
   Idempotent: a released line returns its existing work order. */
function buildWorkOrderFromLine(so, line) {
  var isCount = line.uom !== 'LF';
  var now = new Date().toISOString();
  return {
    id: rid('WO'), number: nextGeneratedWoNumber(),
    property: so.property, account: so.account,
    /* Top-level material fields mirror the generated line: the WO detail
       screen renders these, not lines[]. */
    style: line.style, color: line.color, materialType: line.materialType,
    uom: line.uom, widthIn: line.widthIn, quantity: line.warehouseQtyRequired || 0,
    opStatus: 'OPEN', assignmentStatus: 'UNASSIGNED', assigneeId: null,
    scheduledDate: so.scheduledDate || so.requestedDate || null, scheduledTime: null,
    priority: so.priority || 'NORMAL',
    onHold: false, holdReason: null, holdAt: null, holdBy: null,
    warehouseCompletedAt: null, warehouseCompletedBy: null,
    salesOrderId: so.id, salesOrderLineId: line.id,
    notes: 'Generated from ' + so.number + ' line ' + line.seq + '.',
    createdAt: now,
    lines: [{
      id: rid('WOL'), style: line.style, color: line.color,
      materialType: line.materialType, uom: line.uom, widthIn: line.widthIn,
      requiredIn: isCount ? 0 : (line.warehouseQtyRequired || 0),
      requiredCount: isCount ? line.warehouseQtyRequired : null
    }]
  };
}
function generateWorkOrderFromLine(so, line) {
  var wo = buildWorkOrderFromLine(so, line);
  FG().workOrders.push(wo);
  return wo;
}
function releaseSalesOrderLineLocal(soId, lineId) {
  var pol = orderPolicyRequire(orderPolicy().canReleaseLine, 'SUPERVISOR ROLE REQUIRED');
  if (pol) return pol;
  var so = salesOrderById(soId);
  if (!so) return { ok: false, err: 'SALES ORDER NOT FOUND' };
  if (so.onHold || so.status === SO_STATUS.ON_HOLD) return { ok: false, err: 'SALES ORDER IS ON HOLD' };
  if (so.status === SO_STATUS.CANCELLED) return { ok: false, err: 'SALES ORDER IS CANCELLED' };
  var line = soLineById(so, lineId);
  if (!line) return { ok: false, err: 'LINE NOT FOUND' };
  if (line.status === 'RELEASED') {
    var existing = line.workOrderId && woById(line.workOrderId);
    if (existing) return { ok: true, workOrder: existing, salesOrder: so, duplicate: true };
    /* Released flag without a work order (should not happen) — regenerate. */
  }
  var wo = generateWorkOrderFromLine(so, line);
  line.status = 'RELEASED'; line.workOrderId = wo.id;
  /* Run 6 §14/§16: partial line release — SO status tracks line states. */
  var allRel = (so.lines || []).every(function (l) { return l.status === 'RELEASED'; });
  so.status = allRel ? SO_STATUS.RELEASED_TO_WAREHOUSE : SO_STATUS.PARTIALLY_RELEASED;
  so.updatedAt = new Date().toISOString();
  DB.save();
  logOrderEvent('SALES_ORDER_LINE_RELEASED', { salesOrderId: so.id, salesOrderNumber: so.number,
    workOrderId: wo.id, detail: 'Line ' + line.seq + ' released to warehouse.' });
  logOrderEvent('WORK_ORDER_GENERATED', { salesOrderId: so.id, salesOrderNumber: so.number,
    workOrderId: wo.id, detail: wo.number + ' generated from line ' + line.seq + '.' });
  return { ok: true, workOrder: wo, salesOrder: so };
}

/* ---- Hold / resume / cancel (sales order) ---- */
function holdSalesOrderLocal(soId, reason) {
  var pol = orderPolicyRequire(orderPolicy().canHoldSalesOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var so = salesOrderById(soId);
  if (!so) return { ok: false, err: 'SALES ORDER NOT FOUND' };
  reason = String(reason || '').trim();
  if (!reason) return { ok: false, err: 'REASON REQUIRED' };
  if (so.onHold) return { ok: false, err: 'ALREADY ON HOLD' };
  if (so.status === SO_STATUS.CANCELLED) return { ok: false, err: 'SALES ORDER IS CANCELLED' };
  so.onHold = true; so.holdReason = reason; so.holdAt = new Date().toISOString();
  so.holdBy = DB.data.currentEmployee; so.status = SO_STATUS.ON_HOLD;
  so.updatedAt = so.holdAt;
  DB.save();
  logOrderEvent('SALES_ORDER_HELD', { salesOrderId: so.id, salesOrderNumber: so.number, detail: reason });
  return { ok: true, salesOrder: so };
}
function resumeSalesOrderLocal(soId) {
  var pol = orderPolicyRequire(orderPolicy().canHoldSalesOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var so = salesOrderById(soId);
  if (!so) return { ok: false, err: 'SALES ORDER NOT FOUND' };
  if (!so.onHold) return { ok: false, err: 'NOT ON HOLD' };
  so.onHold = false; so.holdReason = null; so.holdAt = null; so.holdBy = null;
  so.status = SO_STATUS.OPEN;
  so.updatedAt = new Date().toISOString();
  DB.save();
  logOrderEvent('SALES_ORDER_RESUMED', { salesOrderId: so.id, salesOrderNumber: so.number });
  return { ok: true, salesOrder: so };
}
/* Cancellation never silently erases warehouse work: if work orders already
   exist the caller must pass { force: true } after seeing the warning. Cuts
   are never undone. */
function cancelSalesOrderLocal(soId, reason, opts) {
  var pol = orderPolicyRequire(orderPolicy().canCancelSalesOrder, 'MANAGER ROLE REQUIRED');
  if (pol) return pol;
  var so = salesOrderById(soId);
  if (!so) return { ok: false, err: 'SALES ORDER NOT FOUND' };
  reason = String(reason || '').trim();
  if (!reason) return { ok: false, err: 'REASON REQUIRED' };
  if (so.status === SO_STATUS.CANCELLED) return { ok: false, err: 'ALREADY CANCELLED' };
  var wos = (so.lines || []).map(function (l) { return l.workOrderId && woById(l.workOrderId); }).filter(Boolean);
  if (wos.length && !(opts && opts.force))
    return { ok: false, err: 'WAREHOUSE WORK EXISTS', needsConfirmation: true,
      workOrders: wos.map(function (w) { return w.number; }) };
  so.status = SO_STATUS.CANCELLED; so.onHold = false;
  so.updatedAt = new Date().toISOString();
  DB.save();
  logOrderEvent('SALES_ORDER_CANCELLED', { salesOrderId: so.id, salesOrderNumber: so.number,
    detail: reason + (wos.length ? ' (' + wos.length + ' work order(s) already existed — preserved).' : '') });
  return { ok: true, salesOrder: so };
}

/* ---- Property / account directory ----
   Reuses shared Property / Account entities — no duplicate records per
   order. Built from existing work orders, orders, and sales orders plus a
   small known-property seed list, so the selector can later connect with
   the Near Me / Account modules. */
function propertyDirectory() {
  var seen = {}, out = [];
  function add(property, account) {
    var p = String(property || '').trim();
    if (!p) return;
    var k = (p + '|' + String(account || '').trim()).toUpperCase();
    if (seen[k]) return;
    seen[k] = true;
    out.push({ property: p, account: String(account || '').trim() });
  }
  [['Ventura Pointe', 'Willowbridge'], ['Harbor Ridge', 'Seaside Homes'],
   ['Maple St Residence', 'Acme Flooring Co'], ['Oak Ave Residence', 'Acme Flooring Co'],
   ['Pine Rd Residence', 'HomeStyle Interiors'], ['Cedar Ln Residence', 'Acme Flooring Co']].forEach(function (x) { add(x[0], x[1]); });
  (FG().workOrders || []).forEach(function (w) { add(w.property, w.account); });
  (FG().orders || []).forEach(function (o) { add(o.property, o.account); });
  (FG().salesOrders || []).forEach(function (s) { add(s.property, s.account); });
  out.sort(function (a, b) { return a.property < b.property ? -1 : 1; });
  return out;
}
/* Account auto-fill for the order header: exact property match wins. */
function accountForProperty(property) {
  var p = String(property || '').trim().toLowerCase();
  if (!p) return '';
  var hit = propertyDirectory().filter(function (d) { return d.property.toLowerCase() === p; })[0];
  return hit ? hit.account : '';
}

function aiEventLabel(action) {
  var map = { INVENTORY_ASSIGNED: 'INVENTORY ASSIGNED', INVENTORY_RELEASED: 'INVENTORY RELEASED',
    ROLL_VERIFIED: 'ROLL VERIFIED', LOCATION_VERIFIED: 'LOCATION VERIFIED',
    OVER_RESERVATION_APPROVED: 'OVER-RESERVATION APPROVED',
    MATERIAL_MISMATCH_OVERRIDE: 'MATERIAL MISMATCH OVERRIDE',
    ASSIGNMENT_CONSUMED: 'ASSIGNMENT CONSUMED', ROLL_VERIFICATION_OVERRIDDEN: 'ROLL VERIFICATION OVERRIDDEN',
    JOB_HELD: 'JOB PLACED ON HOLD', JOB_RESUMED: 'JOB RESUMED',
    WAREHOUSE_WORK_STARTED: 'WAREHOUSE WORK STARTED',
    WAREHOUSE_WORK_COMPLETED: 'WAREHOUSE WORK COMPLETED',
    WAREHOUSE_WORK_REOPENED: 'WAREHOUSE JOB REOPENED',
    WORK_ORDER_NOTE_ADDED: 'NOTE', EMPLOYEE_ASSIGNED: 'EMPLOYEE ASSIGNED' };
  return map[action] || action;
}
function rollLastCut(rollId) {
  var cuts = (FG().cuts || []).filter(function (c) { return c.rollId === rollId; })
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  return cuts[0] || null;
}
function aiMatches(wo, q) {
  if (!q) return true;
  var hay = [wo.number, wo.id, wo.property, wo.account]
    .concat((wo.lines || []).map(function (l) { return l.style + ' ' + l.color + ' ' + l.materialType; }))
    .concat((FG().inventoryAssignments || []).filter(function (a) { return a.workOrderId === wo.id; })
      .map(function (a) { return a.rollId; }))
    .join(' ').toUpperCase();
  return hay.indexOf(q.toUpperCase()) !== -1;
}

/* ======================================================================
   RUN 6 screens: Order wizard (order/new, order/edit) + Sales Orders.
   Overrides the MODULE_INFO placeholders registered at the generic loop
   above — this block is intentionally placed after it.
   ====================================================================== */

/* Transient wizard state: resets whenever a different order is opened. */
var OWIZ = { orderId: null, step: 1, editItem: null };

/* ---------- shared Run 6 presentation bits ---------- */
function fmtD(ds) {
  if (!ds) return '—';
  var p = ds.split('-');
  var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var m = Number(p[1]);
  return (M[m - 1] || p[1]) + ' ' + Number(p[2]);
}
function orderStatusChip(st) {
  var map = { DRAFT: 'chip', READY_FOR_REVIEW: 'chip chip-blue', SUBMITTED: 'chip chip-green' };
  return '<span class="' + (map[st] || 'chip') + '">' + esc(String(st || '').replace(/_/g, ' ')) + '</span>';
}
function soStatusChip(st) {
  var map = { OPEN: 'chip chip-blue', ON_HOLD: 'chip chip-amber', CANCELLED: 'chip chip-red',
    PARTIALLY_RELEASED: 'chip chip-amber', RELEASED: 'chip chip-green', CLOSED: 'chip chip-gray' };
  return '<span class="' + (map[st] || 'chip') + '">' + esc(String(st || '').replace(/_/g, ' ')) + '</span>';
}
function soLineChip(st) {
  var map = { OPEN: 'chip', RELEASED: 'chip chip-green' };
  return '<span class="' + (map[st] || 'chip') + '">' + esc(st || '') + '</span>';
}
function orderStepsHtml(step) {
  var steps = ['HEADER', 'ITEMS', 'REVIEW'];
  return '<div class="osteps">' + steps.map(function (s, i) {
    var n = i + 1;
    var cls = n === step ? 'os-cur' : (n < step ? 'os-done' : 'os-todo');
    return '<div class="ostep ' + cls + '"><span class="osn">' + n + '</span><span class="osl">' + s + '</span></div>';
  }).join('') + '</div>';
}
function orderLineSummary(it) {
  var parts = [it.style, it.color].filter(function (x) { return x; }).join(' / ');
  var qty = (typeof orderItemQtyDisplay === 'function') ? orderItemQtyDisplay(it) : '';
  return parts + ' · ' + (it.materialType || '') + ' · ' + (it.uom || '') + ' · ' +
    (typeof fmtWidth === 'function' ? fmtWidth(it.widthIn) : (it.widthIn || '')) + ' · ' + qty;
}
function soMaterialSummary(so) {
  var lines = so.lines || [];
  return lines.length + ' MATERIAL LINE' + (lines.length === 1 ? '' : 'S');
}
function soWarehouseChip(so) {
  var released = (so.lines || []).filter(function (l) { return l.status === 'RELEASED'; }).length;
  var n = (so.lines || []).length;
  var t = released + ' OF ' + n + ' LINES RELEASED';
  var cls = released === 0 ? 'chip' : (released < n ? 'chip chip-amber' : 'chip chip-green');
  return '<span class="' + cls + '">' + t + '</span>';
}
/* Header form shared by order/new and order/edit step 1. */
function orderHeaderFormHtml(o) {
  var dir = propertyDirectory();
  var opts = dir.map(function (d) {
    return '<option value="' + esc(d.property) + '">' + esc(d.property) + ' (' + esc(d.account) + ')</option>';
  }).join('');
  return '<div class="card">' +
    '<div class="field"><label class="label" for="oh-prop">PROPERTY *</label>' +
    '<input class="input" id="oh-prop" list="oh-props" value="' + esc(o ? o.property : '') + '" autocomplete="off" placeholder="Start typing a property…">' +
    '<datalist id="oh-props">' + opts + '</datalist></div>' +
    '<div class="field"><label class="label" for="oh-acct">ACCOUNT</label>' +
    '<input class="input" id="oh-acct" value="' + esc(o ? o.account : '') + '" autocomplete="off" placeholder="Auto-fills from the property directory"></div>' +
    '<div class="btn-row">' +
    '<div class="field" style="flex:1"><label class="label" for="oh-req">REQUESTED DATE</label>' +
    '<input class="input" type="date" id="oh-req" value="' + esc((o && o.requestedDate) || '') + '"></div>' +
    '<div class="field" style="flex:1"><label class="label" for="oh-sched">SCHEDULED DATE</label>' +
    '<input class="input" type="date" id="oh-sched" value="' + esc((o && o.scheduledDate) || '') + '"></div>' +
    '</div>' +
    '<div class="field"><label class="label" for="oh-prio">PRIORITY</label>' +
    '<select class="input" id="oh-prio">' + ['NORMAL', 'HIGH', 'URGENT'].map(function (p) {
      return '<option value="' + p + '"' + (o && o.priority === p ? ' selected' : '') + '>' + p + '</option>';
    }).join('') + '</select></div>' +
    '<div class="field"><label class="label" for="oh-ref">INTERNAL REF</label>' +
    '<input class="input" id="oh-ref" value="' + esc(o ? o.internalRef : '') + '" placeholder="Optional" autocomplete="off"></div>' +
    '<div class="field"><label class="label" for="oh-notes">NOTES</label>' +
    '<textarea class="input" id="oh-notes" rows="2">' + esc(o ? o.notes : '') + '</textarea></div>' +
    '<div class="err" id="oh-err" hidden></div>' +
    '</div>';
}
function readOrderHeaderForm() {
  return {
    property: $('#oh-prop').value, account: $('#oh-acct').value,
    requestedDate: $('#oh-req').value || null, scheduledDate: $('#oh-sched').value || null,
    priority: $('#oh-prio').value, internalRef: $('#oh-ref').value, notes: $('#oh-notes').value
  };
}
function mountPropertyAutofill() {
  var dir = propertyDirectory();
  var prop = $('#oh-prop');
  if (!prop) return;
  prop.addEventListener('input', function () {
    var hit = dir.filter(function (d) { return d.property.toLowerCase() === prop.value.trim().toLowerCase(); })[0];
    if (hit) $('#oh-acct').value = hit.account;
  });
}
/* Item form shared by add + edit on the Items step. */
function orderItemFormHtml(it) {
  var types = ['CARPET', 'PAD', 'RESILIENT', 'TILE', 'WOOD', 'OTHER'];
  var uoms = ['LF', 'ROLL', 'BOX', 'EA'];
  it = it || {};
  return '<div class="card">' +
    '<div class="field"><label class="label" for="oi-style">STYLE *</label>' +
    '<input class="input" id="oi-style" value="' + esc(it.style || '') + '" autocomplete="off" placeholder="e.g. Marvel"></div>' +
    '<div class="field"><label class="label" for="oi-color">COLOR</label>' +
    '<input class="input" id="oi-color" value="' + esc(it.color || '') + '" autocomplete="off" placeholder="e.g. Chrome"></div>' +
    '<div class="btn-row">' +
    '<div class="field" style="flex:1"><label class="label" for="oi-type">MATERIAL TYPE</label>' +
    '<select class="input" id="oi-type">' + types.map(function (t) {
      return '<option value="' + t + '"' + (it.materialType === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('') + '</select></div>' +
    '<div class="field" style="flex:1"><label class="label" for="oi-uom">UOM</label>' +
    '<select class="input" id="oi-uom">' + uoms.map(function (u) {
      return '<option value="' + u + '"' + (it.uom === u ? ' selected' : '') + '>' + u + '</option>';
    }).join('') + '</select></div>' +
    '</div>' +
    '<div class="field"><label class="label" for="oi-width">WIDTH (inches)</label>' +
    '<input class="input num" id="oi-width" inputmode="decimal" value="' + esc(it.widthIn != null ? it.widthIn : '') + '" placeholder="e.g. 144"></div>' +
    '<div id="oi-qtywrap">' + orderItemQtyInputsHtml(it) + '</div>' +
    '<div class="field"><label class="label" for="oi-notes">NOTES</label>' +
    '<input class="input" id="oi-notes" value="' + esc(it.notes || '') + '" autocomplete="off"></div>' +
    '<div class="err" id="oi-err" hidden></div>' +
    '<div class="btn-row">' +
    '<button class="btn btn-primary" id="oi-save" style="flex:1">' + (it.id ? 'SAVE ITEM' : 'ADD ITEM') + '</button>' +
    '<button class="btn" id="oi-cancel" style="flex:1">CANCEL</button>' +
    '</div></div>';
}
function orderItemQtyInputsHtml(it) {
  var uom = it.uom || $('#oi-uom') && $('#oi-uom').value || 'LF';
  if (uom === 'LF') {
    var total = it.quantityIn || 0;
    var ft = Math.floor(total / 12), inch = total % 12;
    return '<div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label" for="oi-ft">QUANTITY — FEET *</label>' +
      '<input class="input num" id="oi-ft" inputmode="numeric" value="' + ft + '"></div>' +
      '<div class="field" style="flex:1"><label class="label" for="oi-in">QUANTITY — INCHES</label>' +
      '<input class="input num" id="oi-in" inputmode="numeric" value="' + inch + '"></div>' +
      '</div>';
  }
  return '<div class="field"><label class="label" for="oi-qty">QUANTITY *</label>' +
    '<input class="input num" id="oi-qty" inputmode="decimal" value="' + esc(it.quantity != null ? it.quantity : '') + '" placeholder="e.g. 12"></div>';
}
function readOrderItemForm() {
  var uom = $('#oi-uom').value;
  var rec = {
    style: $('#oi-style').value, color: $('#oi-color').value,
    materialType: $('#oi-type').value, uom: uom,
    widthIn: $('#oi-width').value === '' ? null : Number($('#oi-width').value),
    notes: $('#oi-notes').value
  };
  if (uom === 'LF') {
    var ft = Number($('#oi-ft').value || 0), inch = Number($('#oi-in').value || 0);
    rec.quantityIn = ft * 12 + inch; rec.quantity = null;
  } else {
    rec.quantityIn = null;
    rec.quantity = $('#oi-qty').value === '' ? null : Number($('#oi-qty').value);
  }
  return rec;
}

/* ======================================================================
   ORDER HOME — /order
   ====================================================================== */
Screens['order'] = function () {
  var pol = orderPolicy();
  var drafts = getDraftOrdersLocal();
  var recent = getRecentSubmittedOrdersLocal(5);
  function draftCard(o) {
    return '<button class="ocard" data-id="' + esc(o.id) + '">' +
      '<span class="oc-num mono">' + esc(o.number) + '</span>' +
      '<span class="oc-prop">' + esc(o.property || '—') + '</span>' +
      '<span class="oc-meta">' + (o.items || []).length + ' item' + ((o.items || []).length === 1 ? '' : 's') +
      ' · ' + fmtD(o.requestedDate) + '</span>' +
      orderStatusChip(o.status) + '</button>';
  }
  var html =
    '<div class="screen">' +
    '<div class="step-head">ORDER</div><h1>Order</h1>' +
    (pol.canCreateOrder
      ? '<button class="btn btn-primary" id="ord-new">+ START ORDER</button>'
      : '<p class="hint">Manager role required to create or submit orders.</p>') +
    '<div class="field"><label class="label" for="ord-q">FIND AN ORDER</label>' +
    '<input class="input mono" id="ord-q" autocomplete="off" placeholder="Order or sales order #"></div>' +
    '<div class="sect">DRAFT ORDERS (' + drafts.length + ')</div>' +
    (drafts.length ? '<div class="ocards">' + drafts.map(draftCard).join('') + '</div>'
      : '<p class="hint">No drafts.</p>') +
    '<div class="sect">RECENTLY SUBMITTED</div>' +
    (recent.length ? '<div class="ocards">' + recent.map(function (o) {
      return '<button class="ocard" data-so="' + esc(o.salesOrderId || '') + '">' +
        '<span class="oc-num mono">' + esc(o.number) + '</span>' +
        '<span class="oc-prop">' + esc(o.property || '—') + '</span>' +
        '<span class="oc-meta">SUBMITTED ' + fmtD(o.submittedAt ? o.submittedAt.slice(0, 10) : null) + '</span>' +
        orderStatusChip(o.status) + '</button>';
    }).join('') + '</div>' : '<p class="hint">None yet.</p>') +
    '</div>';
  return { html: html, mount: function () {
    var n = $('#ord-new');
    if (n) n.onclick = function () { go('order/new'); };
    function bindCards() {
      Array.prototype.forEach.call(document.querySelectorAll('.ocard[data-id]'), function (b) {
        b.onclick = function () { go('order/edit', b.getAttribute('data-id')); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('.ocard[data-so]'), function (b) {
        b.onclick = function () { go('sales-order', b.getAttribute('data-so')); };
      });
    }
    bindCards();
    var q = $('#ord-q');
    q.addEventListener('input', function () {
      var needle = q.value.trim().toLowerCase();
      Array.prototype.forEach.call(document.querySelectorAll('.ocards .ocard'), function (b) {
        var txt = (b.querySelector('.oc-num').textContent + ' ' + b.querySelector('.oc-prop').textContent).toLowerCase();
        b.style.display = (!needle || txt.indexOf(needle) >= 0) ? '' : 'none';
      });
    });
  } };
};

/* ======================================================================
   ORDER/NEW — step 1 (header) for a brand-new order.
   ====================================================================== */
/* Run 6 UI plumbing: local mode resolves {ok:false,err}; shared mode
   throws. Normalize both into onErr so denied/offline actions always
   show a message instead of crashing on a missing payload. */
function run6Call(p, onOk, onErr) {
  return p.then(function (res) {
    if (!res || res.ok === false) {
      onErr({ code: 'LOCAL_ERROR', message: (res && res.err) || 'Action failed.' });
      return;
    }
    onOk(res);
  }).catch(onErr);
}
Screens['order/new'] = function () {
  var pol = orderPolicy();
  if (!pol.canCreateOrder)
    return { html: '<div class="screen">' + pageHead('New order', 'Order') +
      '<div class="card"><p class="hint">Manager role required to create orders.</p></div></div>' };
  return {
    html: '<div class="screen">' +
      '<button class="backbtn" id="back">← ORDERS</button>' +
      '<div class="step-head">NEW ORDER</div><h1>Step 1 of 3 — Header</h1>' +
      orderStepsHtml(1) + orderHeaderFormHtml(null) +
      '<button class="btn btn-primary" id="oh-save">SAVE & CONTINUE TO ITEMS →</button>' +
      '</div>',
    mount: function () {
      $('#back').onclick = function () { go('order'); };
      mountPropertyAutofill();
      $('#oh-save').onclick = function () {
        var form = readOrderHeaderForm();
        var err = validateOrderHeader(form);
        var box = $('#oh-err');
        if (err) { box.textContent = err; box.hidden = false; bad(); return; }
        run6Call(Repository.createOrder(form), function (res) {
          good(); toast('Order ' + res.order.number + ' created.');
          OWIZ.orderId = res.order.id; OWIZ.step = 2; OWIZ.editItem = null;
          go('order/edit', res.order.id);
        }, function (e) {
          bad();
          box.textContent = (e && e.code === 'OFFLINE')
            ? 'OFFLINE — order not created. It will not be sent until you are back online.'
            : ((e && e.message) || 'Could not create order.');
          box.hidden = false;
        });
      };
    }
  };
};

/* ======================================================================
   ORDER/EDIT — the three-step wizard for an existing order.
   ====================================================================== */
Screens['order/edit'] = function (param) {
  var o = param && orderById(param);
  if (!o) { setTimeout(function () { go('order'); }, 0); return { html: '' }; }
  if (OWIZ.orderId !== o.id) { OWIZ.orderId = o.id; OWIZ.step = 1; OWIZ.editItem = null; }
  var pol = orderPolicy();
  var editable = pol.canCreateOrder && orderEditable(o);
  var step = OWIZ.step;

  function head(title) {
    return '<button class="backbtn" id="back">← ORDERS</button>' +
      '<div class="step-head">ORDER <span class="mono">' + esc(o.number) + '</span></div>' +
      '<h1>' + title + '</h1>' + orderStepsHtml(step);
  }

  /* ---- step 1: header ---- */
  function step1() {
    return {
      html: '<div class="screen">' + head('Step 1 of 3 — Header') +
        orderHeaderFormHtml(o) +
        '<div class="btn-row">' +
        '<button class="btn btn-primary" id="oh-save" style="flex:1">SAVE & CONTINUE TO ITEMS →</button>' +
        '</div>' +
        (o.status === 'DRAFT' && editable
          ? '<button class="btn btn-danger" id="oh-del">DISCARD DRAFT</button>' : '') +
        '</div>',
      mount: function () {
        $('#back').onclick = function () { go('order'); };
        mountPropertyAutofill();
        var save = $('#oh-save');
        if (save) save.onclick = function () {
          var form = readOrderHeaderForm();
          var err = validateOrderHeader(form);
          var box = $('#oh-err');
          if (err) { box.textContent = err; box.hidden = false; bad(); return; }
          run6Call(Repository.updateOrderHeader(o.id, form), function () {
            good(); toast('Header saved.');
            OWIZ.step = 2; render();
          }, function (e) {
            bad(); box.textContent = (e && e.message) || 'Could not save header.'; box.hidden = false;
          });
        };
        var del = $('#oh-del');
        if (del) del.onclick = function () {
          showConfirm({ title: 'Discard draft?', body: 'Discard draft ' + o.number + '? This cannot be undone.',
            okLabel: 'DISCARD', cancelLabel: 'KEEP' }).then(function (yes) {
            if (!yes) return;
            run6Call(Repository.deleteOrder(o.id), function () {
              good(); toast('Draft discarded.'); go('order');
            }, function (e) { bad(); toast((e && e.message) || 'Could not discard draft.'); });
          });
        };
      }
    };
  }

  /* ---- step 2: items ---- */
  function step2() {
    var items = o.items || [];
    var listHtml = items.length
      ? items.map(function (it) {
          return '<div class="ocard" style="cursor:default">' +
            '<span class="oc-num">LINE ' + it.seq + '</span>' +
            '<span class="oc-prop">' + esc(orderLineSummary(it)) + '</span>' +
            (editable ? '<span class="oc-meta"><button class="btn btn-sm" data-edit="' + esc(it.id) + '">EDIT</button> ' +
              '<button class="btn btn-sm" data-del="' + esc(it.id) + '">REMOVE</button></span>' : '') +
            '</div>';
        }).join('')
      : '<p class="hint">No items yet — add the first material below.</p>';
    var formHtml = '';
    if (editable) {
      if (OWIZ.editItem) {
        var cur = orderItemById(o, OWIZ.editItem) || (OWIZ.editItem === 'new' ? null : null);
        formHtml = '<div class="sect">' + (OWIZ.editItem === 'new' ? 'ADD ITEM' : 'EDIT ITEM') + '</div>' +
          orderItemFormHtml(OWIZ.editItem === 'new' ? null : cur);
      } else {
        formHtml = '<button class="btn" id="oi-add">+ ADD ITEM</button>';
      }
    }
    return {
      html: '<div class="screen">' + head('Step 2 of 3 — Items') +
        '<div class="ocards">' + listHtml + '</div>' + formHtml +
        '<div class="btn-row" style="margin-top:12px">' +
        '<button class="btn" id="oi-back" style="flex:1">← BACK TO HEADER</button>' +
        '<button class="btn btn-primary" id="oi-next" style="flex:1">CONTINUE TO REVIEW →</button>' +
        '</div></div>',
      mount: function () {
        $('#back').onclick = function () { go('order'); };
        $('#oi-back').onclick = function () { OWIZ.step = 1; OWIZ.editItem = null; render(); };
        $('#oi-next').onclick = function () {
          if (!(o.items || []).length) { bad(); toast('Add at least one item first.'); return; }
          OWIZ.step = 3; OWIZ.editItem = null; render();
        };
        var add = $('#oi-add');
        if (add) add.onclick = function () { OWIZ.editItem = 'new'; render(); };
        Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (b) {
          b.onclick = function () { OWIZ.editItem = b.getAttribute('data-edit'); render(); };
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (b) {
          b.onclick = function () {
            showConfirm({ title: 'Remove item?', body: 'Remove this item from the order?',
              okLabel: 'REMOVE', cancelLabel: 'KEEP' }).then(function (yes) {
              if (!yes) return;
              run6Call(Repository.removeOrderItem(o.id, b.getAttribute('data-del')),
                function () { good(); toast('Item removed.'); render(); },
                function (e) { bad(); toast((e && e.message) || 'Could not remove item.'); });
            });
          };
        });
        var uom = $('#oi-uom');
        if (uom) uom.onchange = function () { $('#oi-qtywrap').innerHTML = orderItemQtyInputsHtml({}); };
        var cancel = $('#oi-cancel');
        if (cancel) cancel.onclick = function () { OWIZ.editItem = null; render(); };
        var save = $('#oi-save');
        if (save) save.onclick = function () {
          var form = readOrderItemForm();
          var err = validateOrderItem(form);
          var box = $('#oi-err');
          if (err) { box.textContent = err; box.hidden = false; bad(); return; }
          var p = OWIZ.editItem === 'new'
            ? Repository.addOrderItem(o.id, form)
            : Repository.updateOrderItem(o.id, OWIZ.editItem, form);
          run6Call(p, function () {
            good(); toast('Item saved.');
            OWIZ.editItem = null; render();
          }, function (e) { bad(); box.textContent = (e && e.message) || 'Could not save item.'; box.hidden = false; });
        };
      }
    };
  }

  /* ---- step 3: review + submit ---- */
  function step3() {
    var items = o.items || [];
    var linesHtml = items.map(function (it) {
      return '<div class="kv"><span class="k">LINE ' + it.seq + '</span><span class="v">' +
        esc(orderLineSummary(it)) + '</span></div>';
    }).join('');
    var actionHtml = '';
    if (editable && o.status === 'DRAFT') {
      actionHtml = '<div class="btn-row">' +
        '<button class="btn btn-primary" id="or-ready" style="flex:1">MARK READY</button>' +
        '<button class="btn" id="or-items" style="flex:1">← EDIT ITEMS</button></div>' +
        '<button class="btn" id="or-header">← EDIT HEADER</button>';
    } else if (pol.canSubmitOrder && (o.status === 'READY_FOR_REVIEW' || (o.status === 'DRAFT' && items.length))) {
      actionHtml = '<div class="btn-row">' +
        '<button class="btn btn-primary" id="or-submit" style="flex:1">SUBMIT ORDER →</button>' +
        '<button class="btn" id="or-items" style="flex:1">← EDIT ITEMS</button></div>' +
        '<button class="btn" id="or-header">← EDIT HEADER</button>';
    } else {
      actionHtml = '<p class="hint">This order is ' + esc(o.status) + ' and read-only.</p>';
    }
    return {
      html: '<div class="screen">' + head('Step 3 of 3 — Review') +
        '<div class="card"><h2>Header</h2>' +
        '<div class="kv"><span class="k">Property</span><span class="v">' + esc(o.property) + '</span></div>' +
        '<div class="kv"><span class="k">Account</span><span class="v">' + esc(o.account || '—') + '</span></div>' +
        '<div class="kv"><span class="k">Requested</span><span class="v">' + fmtD(o.requestedDate) + '</span></div>' +
        '<div class="kv"><span class="k">Scheduled</span><span class="v">' + fmtD(o.scheduledDate) + '</span></div>' +
        '<div class="kv"><span class="k">Priority</span><span class="v">' + esc(o.priority) + '</span></div>' +
        '<div class="kv"><span class="k">Status</span><span class="v">' + orderStatusChip(o.status) + '</span></div>' +
        (o.internalRef ? '<div class="kv"><span class="k">Internal ref</span><span class="v mono">' + esc(o.internalRef) + '</span></div>' : '') +
        (o.notes ? '<div class="kv"><span class="k">Notes</span><span class="v">' + esc(o.notes) + '</span></div>' : '') +
        '</div>' +
        '<div class="card"><h2>Items (' + items.length + ')</h2>' + (linesHtml || '<p class="hint">None.</p>') + '</div>' +
        '<div class="err" id="or-err" hidden></div>' +
        actionHtml +
        '</div>',
      mount: function () {
        $('#back').onclick = function () { go('order'); };
        var hi = $('#or-header');
        if (hi) hi.onclick = function () { OWIZ.step = 1; render(); };
        var im = $('#or-items');
        if (im) im.onclick = function () { OWIZ.step = 2; render(); };
        var rd = $('#or-ready');
        if (rd) rd.onclick = function () {
          run6Call(Repository.markOrderReady(o.id), function () {
            good(); toast('Marked ready for review.'); render();
          }, function (e) { bad(); toast((e && e.message) || 'Could not mark ready.'); });
        };
        var sb = $('#or-submit');
        if (sb) sb.onclick = function () {
          var box = $('#or-err');
          box.hidden = true;
          showConfirm({ title: 'Submit order?', body: 'Submit order ' + o.number + ' to the warehouse? This creates the sales order.',
            okLabel: 'SUBMIT ORDER', cancelLabel: 'CANCEL' }).then(function (yes) {
            if (!yes) return;
            run6Call(Repository.submitOrder(o.id), function (res) {
              good(); toast('Sales order ' + res.salesOrder.number + ' created.');
              OWIZ.orderId = null; /* wizard done for this order */
              go('sales-order', res.salesOrder.id);
            }, function (e) {
              bad();
              box.textContent = (e && e.code === 'OFFLINE')
                ? 'OFFLINE — ORDER NOT SUBMITTED. The order was not sent.'
                : ((e && e.message) || 'Submit failed.');
              box.hidden = false;
            });
          });
        };
      }
    };
  }

  if (step === 1) return step1();
  if (step === 2) return step2();
  return step3();
};

/* ======================================================================
   SALES ORDERS LIST — /sales-orders  (param = initial tab)
   ====================================================================== */
var SOTAB = 'OPEN';
/* Spec §13: the four sales-order tabs. */
function salesOrderTabs() { return ['OPEN', 'RELEASED', 'IN PROGRESS', 'COMPLETED']; }
Screens['sales-orders'] = function (param) {
  if (param && salesOrderTabs().indexOf(param) >= 0) SOTAB = param;
  var pol = orderPolicy();
  var tabs = salesOrderTabs();
  var q = '';
  function counts() {
    var c = {};
    tabs.forEach(function (t) { c[t] = salesOrdersByTab(t).length; });
    return c;
  }
  function renderList() {
    var list = salesOrdersByTab(SOTAB).filter(function (so) {
      if (!q) return true;
      var needle = q.toLowerCase();
      return (so.number + ' ' + (so.property || '') + ' ' + (so.account || '')).toLowerCase().indexOf(needle) >= 0;
    });
    var host = $('#so-list');
    if (!host) return;
    host.innerHTML = list.length ? list.map(function (so) {
      var wos = (so.lines || []).filter(function (l) { return l.workOrderId; }).length;
      return '<button class="ocard" data-so="' + esc(so.id) + '">' +
        '<span class="oc-num mono">' + esc(so.number) + '</span>' +
        '<span class="oc-prop">' + esc(so.property || '—') + (so.account ? ' · ' + esc(so.account) : '') + '</span>' +
        '<span class="oc-meta">' + soMaterialSummary(so) + ' · ' + esc(so.priority) +
        (so.scheduledDate ? ' · ' + fmtD(so.scheduledDate) : '') + '</span>' +
        '<span class="oc-chips">' + soStatusChip(so.status) + ' ' + soWarehouseChip(so) +
        (wos ? ' <span class="chip">' + wos + ' WORK ORDER' + (wos === 1 ? '' : 'S') + '</span>' : '') + '</span>' +
        '</button>';
    }).join('') : '<p class="hint">No sales orders in this tab.</p>';
    Array.prototype.forEach.call(host.querySelectorAll('[data-so]'), function (b) {
      b.onclick = function () { go('sales-order', b.getAttribute('data-so')); };
    });
  }
  var c = counts();
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">← DASHBOARD</button>' +
    '<div class="step-head">SALES ORDERS</div><h1>Sales Orders</h1>' +
    '<div class="tabs">' + tabs.map(function (t) {
      return '<button class="tab' + (t === SOTAB ? ' tab-on' : '') + '" data-tab="' + t + '">' +
        t.replace(/_/g, ' ') + ' <span class="tab-n">' + c[t] + '</span></button>';
    }).join('') + '</div>' +
    '<div class="field"><label class="label" for="so-q">SEARCH</label>' +
    '<input class="input mono" id="so-q" autocomplete="off" placeholder="SO #, property, account…"></div>' +
    '<div class="ocards" id="so-list"></div>' +
    (pol.canCreateOrder ? '<button class="btn" id="so-new">+ NEW ORDER</button>' : '') +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { go('dashboard'); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { SOTAB = b.getAttribute('data-tab'); render(); };
    });
    $('#so-q').addEventListener('input', function () { q = this.value.trim(); renderList(); });
    var nb = $('#so-new');
    if (nb) nb.onclick = function () { go('order/new'); };
    renderList();
  } };
};

/* ======================================================================
   SALES ORDER DETAIL — /sales-order/:id
   ====================================================================== */
Screens['sales-order'] = function (param) {
  var so = param && salesOrderById(param);
  if (!so) { setTimeout(function () { go('sales-orders'); }, 0); return { html: '' }; }
  var pol = orderPolicy();
  var releasing = null;

  function lineHtml(l) {
    var canRel = pol.canReleaseLine && l.status === 'OPEN' && !so.onHold && so.status !== 'CANCELLED';
    var woLink = l.workOrderId ? (function () {
      var w = woById(l.workOrderId);
      return '<button class="btn btn-sm" data-wo="' + esc(l.workOrderId) + '">→ ' + esc(w ? w.number : 'WORK ORDER') + '</button>';
    })() : '';
    return '<div class="card soline">' +
      '<div class="kv"><span class="k">LINE ' + l.seq + '</span><span class="v">' + soLineChip(l.status) + '</span></div>' +
      '<div class="kv"><span class="k">Material</span><span class="v">' + esc(l.style) + ' / ' + esc(l.color) + '</span></div>' +
      '<div class="kv"><span class="k">Type / UOM</span><span class="v">' + esc(l.materialType) + ' · ' + esc(l.uom) + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + (typeof fmtWidth === 'function' ? fmtWidth(l.widthIn) : (l.widthIn || '—')) + '</span></div>' +
      '<div class="kv"><span class="k">Warehouse qty' + (l.status === 'OPEN' ? ' (ordered)' : ' required') + '</span>' +
      '<span class="v num">' + esc(orderItemQtyDisplay(l)) + '</span></div>' +
      '<div class="btn-row">' +
      (canRel ? '<button class="btn btn-primary" data-rel="' + esc(l.id) + '" style="flex:1">RELEASE TO WAREHOUSE →</button>' : '') +
      woLink +
      '</div>' +
      '<div class="err" data-relerr="' + esc(l.id) + '" hidden></div>' +
      '</div>';
  }
  function activityHtml() {
    var evs = orderEventsFor(so.id).slice().reverse();
    if (!evs.length) return '<p class="hint">No activity yet.</p>';
    return evs.map(function (e) {
      var when = e.at ? fmtAuditTime(e.at) : '';
      return '<div class="kv"><span class="k">' + esc(when) + '</span><span class="v"><b>' +
        esc(e.type.replace(/_/g, ' ')) + '</b>' +
        (e.by ? ' · ' + esc(e.by) : '') +
        (e.detail ? '<br><span class="hint">' + esc(e.detail) + '</span>' : '') + '</span></div>';
    }).join('');
  }
  function actionsHtml() {
    var out = '';
    if (so.onHold && pol.canHoldSalesOrder)
      out += '<button class="btn" id="so-resume">RESUME SALES ORDER</button>';
    else if (pol.canHoldSalesOrder && so.status !== 'CANCELLED')
      out += '<button class="btn" id="so-hold">PLACE ON HOLD</button>';
    if (pol.canCancelSalesOrder && so.status !== 'CANCELLED')
      out += ' <button class="btn btn-danger" id="so-cancel">CANCEL SALES ORDER</button>';
    return out ? '<div class="btn-row">' + out + '</div>' : '';
  }

  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">← SALES ORDERS</button>' +
    '<div class="step-head">SALES ORDER</div>' +
    '<h1 class="mono">' + esc(so.number) + '</h1>' +
    '<div>' + soStatusChip(so.status) + ' ' + soWarehouseChip(so) + '</div>' +
    '<div class="card">' +
    '<div class="kv"><span class="k">Property</span><span class="v">' + esc(so.property) + '</span></div>' +
    '<div class="kv"><span class="k">Account</span><span class="v">' + esc(so.account || '—') + '</span></div>' +
    '<div class="kv"><span class="k">Requested</span><span class="v">' + fmtD(so.requestedDate) + '</span></div>' +
    '<div class="kv"><span class="k">Scheduled</span><span class="v">' + fmtD(so.scheduledDate) + '</span></div>' +
    '<div class="kv"><span class="k">Priority</span><span class="v">' + esc(so.priority) + '</span></div>' +
    (so.onHold ? '<div class="kv"><span class="k">On hold</span><span class="v">' + esc(so.holdReason || '') +
      (so.holdBy ? ' · ' + esc(so.holdBy) : '') + '</span></div>' : '') +
    (so.notes ? '<div class="kv"><span class="k">Notes</span><span class="v">' + esc(so.notes) + '</span></div>' : '') +
    '</div>' +
    '<h2>Material lines</h2>' +
    (so.lines || []).map(lineHtml).join('') +
    '<h2>Actions</h2>' + actionsHtml() +
    '<h2>Activity</h2><div class="card">' + activityHtml() + '</div>' +
    '</div>';

  return { html: html, mount: function () {
    $('#back').onclick = function () { go('sales-orders', SOTAB); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-wo]'), function (b) {
      b.onclick = function () { go('work-order', b.getAttribute('data-wo')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-rel]'), function (b) {
      b.onclick = function () {
        var lineId = b.getAttribute('data-rel');
        var errBox = document.querySelector('[data-relerr="' + lineId + '"]');
        b.disabled = true; b.textContent = 'RELEASING…';
        run6Call(Repository.releaseSalesOrderLine(so.id, lineId), function (res) {
          good(); toast(res.duplicate ? 'Line already released.' : 'Work order ' + res.workOrder.number + ' generated.');
          go('work-order', res.workOrder.id);
        }, function (e) {
          bad(); b.disabled = false; b.textContent = 'RELEASE TO WAREHOUSE →';
          errBox.textContent = (e && e.code === 'OFFLINE')
            ? 'OFFLINE — SALES ORDER NOT RELEASED. Nothing was sent to the warehouse.'
            : ((e && e.message) || 'Release failed.');
          errBox.hidden = false;
        });
      };
    });
    var hd = $('#so-hold');
    if (hd) hd.onclick = function () { reasonModal('Place ' + so.number + ' on hold?', 'PLACE ON HOLD',
      function (reason) {
        run6Call(Repository.holdSalesOrder(so.id, reason), function () {
          good(); toast('Sales order on hold.'); render();
        }, function (e) { bad(); toast((e && e.message) || 'Hold failed.'); });
      }); };
    var rs = $('#so-resume');
    if (rs) rs.onclick = function () {
      run6Call(Repository.resumeSalesOrder(so.id), function () {
        good(); toast('Sales order resumed.'); render();
      }, function (e) { bad(); toast((e && e.message) || 'Resume failed.'); });
    };
    var cx = $('#so-cancel');
    if (cx) cx.onclick = function () { reasonModal('Cancel ' + so.number + '?', 'CANCEL SALES ORDER',
      function (reason, force) {
        run6Call(Repository.cancelSalesOrder(so.id, reason, { force: force }), function () {
          good(); toast('Sales order cancelled.'); render();
        }, function (e) {
          if (e && e.code === 'WAREHOUSE_WORK_EXISTS') {
            bad();
            showConfirm({ title: 'Work orders exist', body: 'Warehouse work orders already exist: ' +
              (e.data && e.data.workOrders || []).join(', ') +
              '. Cancel the sales order anyway? Existing work orders are kept — never deleted.',
              okLabel: 'CANCEL ANYWAY', cancelLabel: 'KEEP OPEN' }).then(function (yes) {
              if (!yes) return;
              Repository.cancelSalesOrder(so.id, reason, { force: true }).then(function () {
                good(); toast('Sales order cancelled. Existing work kept.'); render();
              }).catch(function (e2) { bad(); toast((e2 && e2.message) || 'Cancel failed.'); });
            });
            return;
          }
          bad(); toast((e && e.message) || 'Cancel failed.');
        });
      }, true); };
  } };
};

/* Small modal: text reason (+ optional "I understand" force checkbox for cancel). */
function reasonModal(title, okLabel, onOk, allowForce) {
  var wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><h2>' + esc(title) + '</h2>' +
    '<div class="field"><label class="label">REASON (required)</label>' +
    '<input class="input" id="rm-reason" autocomplete="off"></div>' +
    (allowForce ? '<label class="hint"><input type="checkbox" id="rm-force"> Keep existing work orders (they are never deleted)</label>' : '') +
    '<div class="err" id="rm-err" hidden></div>' +
    '<div class="btn-row"><button class="btn btn-primary" id="rm-ok" style="flex:1">' + esc(okLabel) + '</button>' +
    '<button class="btn" id="rm-cancel" style="flex:1">CANCEL</button></div></div>';
  document.body.appendChild(wrap);
  wrap.querySelector('#rm-cancel').onclick = function () { wrap.remove(); };
  wrap.querySelector('#rm-ok').onclick = function () {
    var reason = wrap.querySelector('#rm-reason').value.trim();
    if (!reason) {
      var box = wrap.querySelector('#rm-err');
      box.textContent = 'A reason is required.'; box.hidden = false; bad(); return;
    }
    var force = allowForce && wrap.querySelector('#rm-force').checked;
    wrap.remove();
    onOk(reason, force);
  };
}
/* Hub: NEEDS INVENTORY / ASSIGNED / COMPLETED + search + filters.
   Also honors assign-inventory?workOrder=XS024536 (query) and
   assign-inventory/wo/<id> (path) entry from a work order. */
Screens['assign-inventory'] = function () {
  var raw = parseHash();
  var qm = raw.match(/^assign-inventory\?(.+)$/);
  if (qm) {
    var qp = {};
    qm[1].split('&').forEach(function (pair) {
      var kv = pair.split('=');
      qp[decodeURIComponent(kv[0] || '')] = decodeURIComponent(kv[1] || '');
    });
    if (qp.workOrder) {
      var wq = woByNumber(qp.workOrder) || woById(qp.workOrder);
      if (wq) { setTimeout(function () { go('assign-inventory/wo', wq.id); }, 0); return { html: '' }; }
    }
  }
  var wos = FG().workOrders || [];
  var assigns = FG().inventoryAssignments || [];
  var props = [], mtypes = [], emps = [];
  wos.forEach(function (w) {
    if (w.property && props.indexOf(w.property) < 0) props.push(w.property);
    (w.lines || []).forEach(function (l) {
      if (l.materialType && mtypes.indexOf(l.materialType) < 0) mtypes.push(l.materialType);
    });
    var an = woAssigneeName(w);
    if (an && emps.indexOf(an) < 0) emps.push(an);
  });
  assigns.forEach(function (a) {
    if (a.employee && emps.indexOf(a.employee) < 0) emps.push(a.employee);
  });
  function selOpts(list, cur, label) {
    return '<option value="">' + label + '</option>' + list.map(function (v) {
      return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('');
  }
  var needsRows = '', assignedRows = '', completedRows = '';
  var nNeeds = 0, nAssigned = 0, nCompleted = 0;
  wos.forEach(function (w) {
    if (w.opStatus === 'COMPLETE') return;
    if (AIHUB.emp && woAssigneeName(w) !== AIHUB.emp) return;
    if (AIHUB.prop && w.property !== AIHUB.prop) return;
    if (AIHUB.mtype && !(w.lines || []).some(function (l) { return l.materialType === AIHUB.mtype; })) return;
    if (!aiMatches(w, AIHUB.q)) return;
    var openLines = (w.lines || []).filter(function (l) {
      var st = lineStatus(w, l);
      return st === 'NOT_ASSIGNED' || st === 'PARTIALLY_ASSIGNED';
    });
    if (!openLines.length) return;
    nNeeds++;
    needsRows += '<button class="rowbtn" data-wo="' + esc(w.id) + '">' +
      '<div class="rhead"><b class="mono">' + esc(w.number) + '</b> ' + woStatusChip(w) + '</div>' +
      '<div class="sub">' + esc(w.property) + ' &middot; ' + esc(w.account) + '</div>' +
      openLines.map(function (l) {
        return '<div class="sub">' + esc(l.style) + ' / ' + esc(l.color) + ' &middot; req <b class="num">' +
          fmtLen(l.requiredIn) + '</b> ' + aiLineStatusChip(lineStatus(w, l)) + '</div>';
      }).join('') + '</button>';
  });
  function assignRow(a) {
    var w = woById(a.workOrderId);
    var l = w ? lineById(w, a.lineId) : null;
    return '<button class="rowbtn" data-a="' + esc(a.id) + '">' +
      '<div class="rhead"><b class="mono">' + esc(w ? w.number : a.workOrderId) + '</b> ' +
      aiAssignStatusChip(a.status) + '</div>' +
      '<div class="sub">Roll <b class="mono">' + esc(a.rollId) + '</b> &middot; reserved <b class="num">' +
      fmtLen(a.reservedIn) + '</b>' + (l ? ' &middot; ' + esc(l.style) + ' / ' + esc(l.color) : '') + '</div>' +
      '<div class="sub">' + esc(a.employee) + ' &middot; ' + fmtDT(a.at) + '</div></button>';
  }
  assigns.forEach(function (a) {
    if (AIHUB.emp && a.employee !== AIHUB.emp) return;
    if (AIHUB.date && String(a.at).slice(0, 10) !== AIHUB.date) return;
    var w = woById(a.workOrderId);
    if (AIHUB.prop && (!w || w.property !== AIHUB.prop)) return;
    var l = w ? lineById(w, a.lineId) : null;
    if (AIHUB.mtype && (!l || l.materialType !== AIHUB.mtype)) return;
    if (AIHUB.q && (w ? !aiMatches(w, AIHUB.q) : true) &&
        String(a.rollId).toUpperCase().indexOf(AIHUB.q.toUpperCase()) < 0) return;
    if (a.status === AI_STATUS.RESERVED) { nAssigned++; assignedRows += assignRow(a); }
    else if (a.status === AI_STATUS.CONSUMED) { nCompleted++; completedRows += assignRow(a); }
  });
  function tabBtn(key, label, n) {
    return '<button class="tabbtn' + (AIHUB.tab === key ? ' active' : '') + '" data-tab="' + key + '">' +
      label + ' <span class="tabcount">' + n + '</span></button>';
  }
  var listHtml = AIHUB.tab === 'needs' ? (needsRows || '<p class="hint">Every open work order is fully assigned.</p>')
    : AIHUB.tab === 'assigned' ? (assignedRows || '<p class="hint">No active reservations.</p>')
    : (completedRows || '<p class="hint">No completed assignments yet.</p>');
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">WAREHOUSE</div>' +
    '<h1>ASSIGN INVENTORY</h1>' +
    '<div class="card">' +
      '<div class="label">SEARCH WORK ORDER</div>' +
      '<div class="field"><input class="input mono" id="ai-q" autocomplete="off" autocapitalize="characters" ' +
        'placeholder="WO #, property, account, style, color, roll" value="' + esc(AIHUB.q) + '"></div>' +
      '<div class="label">SCAN / ENTER WORK ORDER</div>' +
      '<div class="cambox" id="ai-cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
      '<form id="ai-woform"><div class="field"><input class="input mono" id="ai-wo" autocomplete="off" ' +
        'autocapitalize="characters" placeholder="e.g. XS024536"></div>' +
      '<button class="btn btn-primary btn-huge" type="submit">OPEN WORK ORDER</button></form>' +
      '<div class="demolabel">DEMO &mdash; TAP A WORK ORDER</div>' +
      '<div class="demochips">' + wos.map(function (w) {
        return '<button class="demochip" data-wochip="' + esc(w.number) + '">' + esc(w.number) + '</button>';
      }).join('') + '</div>' +
      '<div id="ai-woresult"></div>' +
    '</div>' +
    '<div class="tabs">' + tabBtn('needs', 'NEEDS INVENTORY', nNeeds) +
      tabBtn('assigned', 'ASSIGNED', nAssigned) + tabBtn('completed', 'COMPLETED', nCompleted) + '</div>' +
    '<div class="card"><div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">EMPLOYEE</label>' +
        '<select class="input" id="ai-femp">' + selOpts(emps, AIHUB.emp, 'All') + '</select></div>' +
      '<div class="field" style="flex:1"><label class="label">PROPERTY</label>' +
        '<select class="input" id="ai-fprop">' + selOpts(props, AIHUB.prop, 'All') + '</select></div>' +
    '</div><div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">MATERIAL TYPE</label>' +
        '<select class="input" id="ai-fmtype">' + selOpts(mtypes, AIHUB.mtype, 'All') + '</select></div>' +
      '<div class="field" style="flex:1"><label class="label">DATE</label>' +
        '<input class="input" type="date" id="ai-fdate" value="' + esc(AIHUB.date) + '"></div>' +
    '</div></div>' +
    '<div id="ai-list">' + listHtml + '</div>' +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { go('dashboard'); };
    $('#ai-q').addEventListener('input', function () { AIHUB.q = $('#ai-q').value; render(); });
    $('#ai-femp').onchange = function () { AIHUB.emp = $('#ai-femp').value; render(); };
    $('#ai-fprop').onchange = function () { AIHUB.prop = $('#ai-fprop').value; render(); };
    $('#ai-fmtype').onchange = function () { AIHUB.mtype = $('#ai-fmtype').value; render(); };
    $('#ai-fdate').onchange = function () { AIHUB.date = $('#ai-fdate').value; render(); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { AIHUB.tab = b.getAttribute('data-tab'); render(); };
    });
    mountScannerBox('ai-cambox', openWO);
    $('#ai-woform').onsubmit = function (e) { e.preventDefault(); openWO($('#ai-wo').value); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-wochip]'), function (c) {
      c.onclick = function () { openWO(c.getAttribute('data-wochip')); };
    });
    function openWO(code) {
      var w = woByNumber(code);
      if (!w) { bad(); $('#ai-woresult').innerHTML = '<div class="err center">&#10060; WORK ORDER NOT FOUND — try again.</div>'; return; }
      good(); go('assign-inventory/wo', w.id);
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-wo]'), function (b) {
      b.onclick = function () { go('assign-inventory/wo', b.getAttribute('data-wo')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-a]'), function (b) {
      b.onclick = function () { go('assign-inventory/a', b.getAttribute('data-a')); };
    });
  }};
};

/* Work order summary + material lines. */
Screens['assign-inventory/wo'] = function (param) {
  var w = woById(param);
  if (!w) { setTimeout(function () { go('assign-inventory'); }, 0); return { html: '' }; }
  var an = woAssigneeName(w);
  var linesHtml = (w.lines || []).map(function (l) {
    var st = lineStatus(w, l);
    var act = activeAssignments(w.id, l.id);
    var hist = allAssignmentsForLine(w.id, l.id).filter(function (a) { return a.status !== AI_STATUS.RESERVED; });
    var reqLF = (l.requiredIn / 12);
    return '<div class="card">' +
      '<div class="rhead"><b>' + esc(l.style) + ' / ' + esc(l.color) + '</b> ' + aiLineStatusChip(st) + '</div>' +
      '<div class="kv"><span class="k">Material Type</span><span class="v">' + esc(l.materialType || '—') + '</span></div>' +
      '<div class="kv"><span class="k">UOM</span><span class="v">' + esc(l.uom || '—') + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + fmtWidth(l.widthIn) + '</span></div>' +
      '<div class="kv"><span class="k">Required Quantity</span><span class="v num">' + reqLF.toFixed(2) + ' ' + esc(l.uom || 'LF') +
        ' <span class="sub">(' + fmtLen(l.requiredIn) + ')</span></span></div>' +
      (act.length ? '<div class="label" style="margin-top:8px">ASSIGNED INVENTORY</div>' + act.map(function (a) {
        return '<button class="rowbtn" data-a="' + esc(a.id) + '">' +
          '<div class="rhead"><b class="mono">' + esc(a.rollId) + '</b> ' + aiAssignStatusChip(a.status) + '</div>' +
          '<div class="sub">Reserved <b class="num">' + fmtLen(a.reservedIn) + '</b> &middot; ' + esc(a.employee) +
          ' &middot; ' + fmtDT(a.at) + '</div></button>';
      }).join('') : (st === 'COMPLETED'
        ? '<p class="hint">Inventory assigned and cut for this line.</p>'
        : '<p class="hint">No inventory assigned yet.</p>')) +
      (hist.length ? '<div class="label" style="margin-top:8px">PAST ASSIGNMENTS</div>' + hist.map(function (a) {
        return '<button class="rowbtn" data-a="' + esc(a.id) + '">' +
          '<div class="rhead"><b class="mono">' + esc(a.rollId) + '</b> ' + aiAssignStatusChip(a.status) + '</div>' +
          '<div class="sub">' + (a.status === AI_STATUS.CONSUMED
            ? 'Cut <b class="num">' + fmtLen(a.actualCutIn != null ? a.actualCutIn : a.reservedIn) + '</b>'
            : 'Released <b class="num">' + fmtLen(a.reservedIn) + '</b>') +
          ' &middot; ' + esc(a.employee) + ' &middot; ' + fmtDT(a.at) + '</div></button>';
      }).join('') : '') +
      ((st === 'ASSIGNED' || st === 'COMPLETED')
        ? '<button class="btn" data-assign="' + esc(l.id) + '">ASSIGN ANOTHER ROLL</button>'
        : '<button class="btn btn-primary btn-huge" data-assign="' + esc(l.id) + '">&#128205; ASSIGN ROLL</button>') +
    '</div>';
  }).join('');
  var evts = assignEventsForWO(w.id);
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">ASSIGN INVENTORY</div>' +
    '<div class="label">WORK ORDER</div>' +
    '<h1 class="mono">' + esc(w.number) + '</h1>' +
    '<div>' + woAssignChip(w) + ' ' + woStatusChip(w) + '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Property</span><span class="v">' + esc(w.property) + '</span></div>' +
      '<div class="kv"><span class="k">Account</span><span class="v">' + esc(w.account) + '</span></div>' +
      '<div class="kv"><span class="k">Assigned Employee</span><span class="v">' + esc(an || 'Unassigned') + '</span></div>' +
    '</div>' +
    '<h2>Material Lines</h2>' + linesHtml +
    '<h2>Inventory Activity</h2>' +
    (evts.length ? evts.map(function (e) {
      return '<div class="trow"><div><b>' + esc(aiEventLabel(e.action)) + '</b>' +
        (e.rollId ? ' <span class="mono">' + esc(e.rollId) + '</span>' : '') +
        (e.detail ? '<div class="sub">' + esc(e.detail) + '</div>' : '') + '</div>' +
        '<div class="sub">' + esc(e.user) + '<br>' + fmtDT(e.at) + '</div></div>';
    }).join('') : '<p class="hint">No inventory activity yet.</p>') +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { go('assign-inventory'); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-assign]'), function (b) {
      b.onclick = function () { go('assign-inventory/assign', w.id + '/' + b.getAttribute('data-assign')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-a]'), function (b) {
      b.onclick = function () { go('assign-inventory/a', b.getAttribute('data-a')); };
    });
  }};
};

/* Assign-roll flow: scan/search roll -> roll detail + checks -> confirm. */
Screens['assign-inventory/assign'] = function (param) {
  var parts = String(param || '').split('/');
  var w = woById(parts[0]);
  var line = w ? lineById(w, parts[1]) : null;
  if (!w || !line) { setTimeout(function () { go('assign-inventory'); }, 0); return { html: '' }; }
  if (!AI || AI.woId !== w.id || AI.lineId !== line.id) AI = { woId: w.id, lineId: line.id, rollId: null, discCode: null, phase: 'scan' };
  var html = '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">ASSIGN INVENTORY &mdash; ' + esc(w.number) + '</div>' +
    '<h1>Assign roll</h1>' +
    '<div class="card"><div class="kv"><span class="k">Material</span><span class="v"><b>' + esc(line.style) + ' / ' + esc(line.color) +
      '</b></span></div>' +
      '<div class="kv"><span class="k">Required</span><span class="v num">' + fmtLen(line.requiredIn) + '</span></div></div>' +
    '<div id="ai-body"></div></div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { AI = null; go('assign-inventory/wo', w.id); };
    renderBody();
    function renderBody() {
      var body = $('#ai-body');
      if (AI.phase === 'scan') body.innerHTML = scanHtml(), mountScan();
      else if (AI.phase === 'roll') body.innerHTML = rollHtml(), mountRoll();
      else if (AI.phase === 'done') body.innerHTML = doneHtml(), mountDone();
    }
    function scanHtml() {
      if (AI.discCode) {
        return '<div class="warn-panel"><div class="big-ok">&#10067; UNKNOWN ROLL</div>' +
          '<p class="hint">"' + esc(AI.discCode) + '" is not in FloorGuard. Create it as a discovered roll, then assignment can continue.</p></div>' +
          '<div class="card"><div class="label">DISCOVER ROLL</div>' +
          '<div class="field"><label class="label">CURRENT LOCATION</label>' +
            '<input class="input mono" id="disc-loc" autocomplete="off" autocapitalize="characters" placeholder="e.g. 205B"></div>' +
          '<div class="label">MEASURED BALANCE (optional)</div>' +
          '<div class="btn-row"><div class="field" style="flex:1"><label class="label">FEET</label>' +
            '<input class="input num" id="disc-ft" inputmode="numeric" autocomplete="off" placeholder="0"></div>' +
          '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
            '<input class="input num" id="disc-in" inputmode="decimal" autocomplete="off" placeholder="0"></div></div>' +
          '<button class="btn btn-primary btn-huge" id="disc-go">DISCOVER ROLL</button>' +
          '<button class="btn" id="disc-cancel">CANCEL</button></div>';
      }
      var chips = FG().rolls.map(function (r) {
        return '<button class="demochip" data-code="' + esc(r.barcode) + '">' + esc(r.barcode) + '</button>';
      }).join('');
      var rollOpts = FG().rolls.map(function (r) {
        return '<button class="rowbtn" data-rollpick="' + esc(r.id) + '">' +
          '<div class="rhead"><b class="mono">' + esc(r.id) + '</b> <span class="sub">' + esc(r.style) + ' / ' + esc(r.color) + '</span></div>' +
          '<div class="sub">loc <b class="mono">' + esc(r.expectedLocation) + '</b> &middot; bal <b class="num">' + fmtLen(systemBalance(r.id)) + '</b></div></button>';
      }).join('');
      return '<div class="card"><div class="label">SCAN ROLL</div>' +
        '<div class="cambox" id="ai-rollcam"><div class="camnote">Starting camera&hellip;</div></div>' +
        '<form id="ai-rollform"><div class="field"><label class="label">OR TYPE / WEDGE THE BARCODE</label>' +
        '<input class="input mono" id="ai-rollcode" autocomplete="off" autocapitalize="characters" placeholder="e.g. 16628697"></div>' +
        '<button class="btn btn-primary btn-huge" type="submit">FIND ROLL</button></form>' +
        '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
        '<div class="demochips">' + chips + '</div>' +
        '<div id="ai-rollresult"></div></div>' +
        '<div class="label" style="margin:12px 0 8px">SEARCH ROLL</div>' +
        '<div class="field"><input class="input" id="ai-rollsearch" autocomplete="off" placeholder="Filter rolls&hellip;"></div>' +
        '<div id="ai-rolllist">' + rollOpts + '</div>';
    }
    function mountScan() {
      if (AI.discCode) {
        $('#disc-cancel').onclick = function () { AI.discCode = null; renderBody(); };
        $('#disc-go').onclick = function () {
          var ft = parseFloat($('#disc-ft').value) || 0, inch = parseFloat($('#disc-in').value) || 0;
          var meas = ($('#disc-ft').value.trim() === '' && $('#disc-in').value.trim() === '') ? null : Math.round(ft * 12 + inch);
          var res = discoverRollForAssign(AI.discCode, {
            employee: DB.data.currentEmployee, location: $('#disc-loc').value, measuredIn: meas
          });
          if (!res.ok) { bad(); return; }
          good();
          AI.rollId = res.roll.id; AI.discCode = null; AI.phase = 'roll';
          renderBody();
        };
        return;
      }
      mountScannerBox('ai-rollcam', onRollCode);
      $('#ai-rollform').onsubmit = function (e) { e.preventDefault(); onRollCode($('#ai-rollcode').value); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-code]'), function (c) {
        c.onclick = function () { onRollCode(c.getAttribute('data-code')); };
      });
      $('#ai-rollsearch').addEventListener('input', function () {
        var q = $('#ai-rollsearch').value.toUpperCase();
        Array.prototype.forEach.call(document.querySelectorAll('[data-rollpick]'), function (b) {
          b.style.display = b.textContent.toUpperCase().indexOf(q) >= 0 ? '' : 'none';
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-rollpick]'), function (b) {
        b.onclick = function () { AI.rollId = b.getAttribute('data-rollpick'); AI.phase = 'roll'; renderBody(); };
      });
    }
    function onRollCode(code) {
      var norm = normalizeBarcode(code);
      if (!norm) return;
      var roll = rollByBarcode(norm);
      if (roll) { good(); AI.rollId = roll.id; AI.phase = 'roll'; renderBody(); return; }
      var disc = (typeof findDiscovered === 'function') ? findDiscovered(norm) : null;
      if (disc) { good(); AI.rollId = disc.id; AI.phase = 'roll'; renderBody(); return; }
      bad(); AI.discCode = code; renderBody();
    }
    function rollHtml() {
      var roll = assignableRoll(AI.rollId);
      if (!roll) { AI.phase = 'scan'; return scanHtml(); }
      var disc = isDiscoveredRoll(roll);
      var bal = assignableBalance(roll);
      var compat = checkCompatibility(roll, line);
      var needIn = line.requiredIn;
      var alreadyLine = activeAssignments(w.id, line.id).reduce(function (s, a) { return s + a.reservedIn; }, 0);
      var stillNeed = Math.max(0, needIn - alreadyLine);
      var resOnRoll = reservedOnRoll(roll.id);
      var potAvail = potentialAvailable(roll);
      var lastCut = disc ? null : rollLastCut(roll.id);
      var qtyOk = bal != null && bal >= needIn;
      var ov = overReserved(roll.id, stillNeed || needIn);
      var loc = disc ? (roll.lastLocation || '—') : roll.expectedLocation;
      var h = '<div class="card">' +
        '<div class="rhead"><b class="mono" style="font-size:1.4rem">' + esc(roll.id) + '</b>' +
        (disc ? ' <span class="stchip st-blue">NEWLY DISCOVERED</span>' : '') + '</div>' +
        '<div class="kv"><span class="k">ROLL ID</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
        '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style || 'NOT YET IMPORTED') + '</span></div>' +
        '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color || 'NOT YET IMPORTED') + '</span></div>' +
        '<div class="kv"><span class="k">Width</span><span class="v">' + (roll.widthIn ? fmtWidth(roll.widthIn) : '—') + '</span></div>' +
        '<div class="kv"><span class="k">Current Location</span><span class="v mono">' + esc(loc) + '</span></div>' +
        '<div class="kv"><span class="k">Expected Balance</span><span class="v num" style="font-size:1.3rem">' +
          (bal != null ? fmtLen(bal) : 'UNKNOWN') + '</span></div>' +
        (!disc ?
          '<div class="kv"><span class="k">Measured Balance</span><span class="v num">' +
            (roll.measuredIn != null ? fmtLen(roll.measuredIn) + ' <span class="stchip st-green">MB ✓</span>' : 'Not measured yet') + '</span></div>' +
          (roll.measuredAt ? '<div class="kv"><span class="k">Last Measurement</span><span class="v">' + fmtDT(roll.measuredAt) +
            ' &middot; ' + esc(roll.measuredBy || '') + '</span></div>' : '') +
          '<div class="kv"><span class="k">Last Cut</span><span class="v">' +
            (lastCut ? fmtLen(lastCut.inches) + ' &middot; ' + esc(lastCut.by) + ' &middot; ' + fmtDT(lastCut.at) : 'None recorded') + '</span></div>'
        : '<div class="kv"><span class="k">Measured at Discovery</span><span class="v num">' +
            (roll.lastMeasuredIn != null ? fmtLen(roll.lastMeasuredIn) : '—') + '</span></div>') +
        '<div class="kv"><span class="k">Reserved (all jobs)</span><span class="v num">' + fmtLen(resOnRoll) + '</span></div>' +
        '<div class="kv"><span class="k">Potential Available</span><span class="v num">' +
          (potAvail != null ? fmtLen(potAvail) : '—') + '</span></div>' +
        '<div class="btn-row"><button class="btn" id="ai-newroll" style="flex:1">SCAN DIFFERENT ROLL</button>' +
        '<button class="btn" id="ai-verloc" style="flex:1">&#128205; VERIFY LOCATION</button></div></div>' +
        aiCompatBanner(compat) +
        '<div class="card"><div class="label">QUANTITY CHECK</div>' +
        '<div class="kv"><span class="k">Required</span><span class="v num">' + fmtLen(needIn) + '</span></div>' +
        '<div class="kv"><span class="k">Roll Balance</span><span class="v num">' + (bal != null ? fmtLen(bal) : 'UNKNOWN') + '</span></div>' +
        (bal != null
          ? (qtyOk ? '<div class="ok-panel"><div class="big-ok">&#10003; SUFFICIENT MATERIAL</div></div>'
                   : '<div class="warn-panel"><div class="big-ok">&#9888;&#65039; INSUFFICIENT MATERIAL</div>' +
                     '<p class="hint">Required ' + fmtLen(needIn) + ', available ' + fmtLen(bal) +
                     '. Select another roll — multiple rolls can cover one line.</p></div>')
          : '<div class="warn-panel"><div class="big-ok">BALANCE UNKNOWN</div><p class="hint">Supervisor review required.</p></div>') +
        '</div>';
      if (ov.over) {
        h += '<div class="warn-panel"><div class="big-ok">&#9888;&#65039; OVER-RESERVED</div>' +
          '<div class="kv"><span class="k">Expected</span><span class="v num">' + fmtLen(ov.balance) + '</span></div>' +
          '<div class="kv"><span class="k">Existing Reservations</span><span class="v num">' + fmtLen(resOnRoll) + '</span></div>' +
          '<div class="kv"><span class="k">This Reservation</span><span class="v num">' + fmtLen(stillNeed || needIn) + '</span></div>' +
          '<div class="kv"><span class="k">Total Reserved</span><span class="v num">' + fmtLen(ov.total) + '</span></div>' +
          '<p class="hint">Supervisor confirmation required before assigning.</p></div>';
      }
      var needsSup = compat.verdict !== 'MATCH' || ov.over || bal == null;
      var sup = isSupervisorRole(DB.data.currentEmployee);
      var dft = Math.floor((stillNeed || needIn) / 12), din = (stillNeed || needIn) % 12;
      h += '<div class="card"><div class="label">RESERVE QUANTITY</div>' +
        '<div class="btn-row"><div class="field" style="flex:1"><label class="label">FEET</label>' +
          '<input class="input num" id="ai-ft" inputmode="numeric" autocomplete="off" value="' + dft + '"></div>' +
        '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
          '<input class="input num" id="ai-in" inputmode="decimal" autocomplete="off" value="' + din + '"></div></div>';
      if (needsSup) {
        h += sup
          ? '<label class="checkline"><input type="checkbox" id="ai-supok"> <b>SUPERVISOR APPROVAL</b> — I (' +
            esc(DB.data.currentEmployee) + ') approve this assignment.</label>'
          : '<div class="err center">SUPERVISOR APPROVAL REQUIRED<br><span class="hint">Ask a supervisor (e.g. Marcus) to sign in and approve.</span></div>';
      }
      h += '<div class="err" id="ai-err" hidden></div>' +
        '<button class="btn btn-primary btn-huge" id="ai-assign">ASSIGN INVENTORY</button></div>';
      return h;
    }
    function mountRoll() {
      $('#ai-newroll').onclick = function () { AI.rollId = null; AI.phase = 'scan'; renderBody(); };
      $('#ai-verloc').onclick = function () {
        var roll = assignableRoll(AI.rollId);
        go('assign-inventory/verify-loc', 'pending/' + encodeURIComponent(roll.id) + '/' + encodeURIComponent(w.id + '/' + line.id));
      };
      var supbox = $('#ai-supok');
      $('#ai-assign').onclick = function () {
        var roll = assignableRoll(AI.rollId);
        var ft = parseFloat($('#ai-ft').value) || 0, inch = parseFloat($('#ai-in').value) || 0;
        var reservedIn = Math.round(ft * 12 + inch);
        var compat = checkCompatibility(roll, line);
        var ov = overReserved(roll.id, reservedIn);
        var bal = assignableBalance(roll);
        var needsSup = compat.verdict !== 'MATCH' || ov.over || bal == null;
        var supName = null;
        if (needsSup) {
          if (!isSupervisorRole(DB.data.currentEmployee) || !(supbox && supbox.checked)) {
            var e = $('#ai-err'); e.textContent = 'SUPERVISOR APPROVAL REQUIRED'; e.hidden = false; bad(); return;
          }
          supName = DB.data.currentEmployee;
        }
        var res2 = {
          woId: w.id, lineId: line.id, rollId: roll.id, reservedIn: reservedIn,
          employee: DB.data.currentEmployee,
          mismatchApprovedBy: (compat.verdict !== 'MATCH' || bal == null) ? supName : null,
          overApprovedBy: ov.over ? supName : null,
          /* Stable idempotency key for this assignment intent: a double-tap
             or a retried submit replays the same reservation, never a new one. */
          clientRequestId: AI.reqId || (AI.reqId = rid('AR'))
        };
        assignInventoryAsync(res2).then(function (res) {
          if (!res.ok) { var e2 = $('#ai-err'); e2.textContent = res.err; e2.hidden = false; bad(); return; }
          good();
          AI.reqId = null;
          AI.assignId = res.rec.id; AI.assignRec = res.rec; AI.phase = 'done';
          renderBody();
        }).catch(function (err) {
          bad();
          var e3 = $('#ai-err');
          if (err && err.code === 'OFFLINE') {
            e3.textContent = 'OFFLINE — RESERVATION NOT SYNCED. Reconnect and try again.';
          } else if (err && err.code === 'ROLL_VERSION_CONFLICT') {
            e3.innerHTML = 'ROLL UPDATED BY ANOTHER DEVICE. <button class="btn" id="ai-ref2">REFRESH</button>';
            var rb2 = $('#ai-ref2');
            if (rb2) rb2.onclick = function () {
              Repository.refresh().then(function () { renderBody(); }).catch(function () { renderBody(); });
            };
          } else {
            e3.textContent = (err && err.message) || 'Assignment failed.';
          }
          e3.hidden = false;
        });
      };
    }
    function doneHtml() {
      /* Prefer the record reference captured at creation; fall back to a
         store lookup so a re-render can never show a phantom "not found". */
      var rec = AI.assignRec ||
        (FG().inventoryAssignments || []).filter(function (a) { return a.id === AI.assignId; })[0];
      if (!rec) return '<p class="hint">Assignment not found.</p>';
      return '<div class="ok-panel"><div class="big-ok">&#10003; INVENTORY ASSIGNED</div>' +
        '<div class="kv"><span class="k">Assignment</span><span class="v mono">' + esc(rec.id) + '</span></div>' +
        '<div class="kv"><span class="k">Roll</span><span class="v mono">' + esc(rec.rollId) + '</span></div>' +
        '<div class="kv"><span class="k">Quantity Reserved</span><span class="v num">' + fmtLen(rec.reservedIn) + '</span></div>' +
        '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(rec.employee) + '</span></div>' +
        '<div class="kv"><span class="k">Status</span><span class="v">' + aiAssignStatusChip(rec.status) + '</span></div></div>' +
        '<p class="hint">The reservation does not change the roll balance. The balance changes only when the cut is recorded.</p>' +
        '<button class="btn btn-primary btn-huge" id="ai-tocut">&#9986; CONTINUE TO CUT</button>' +
        '<button class="btn" id="ai-towo">BACK TO WORK ORDER</button>';
    }
    function mountDone() {
      $('#ai-towo').onclick = function () { AI = null; go('assign-inventory/wo', w.id); };
      $('#ai-tocut').onclick = function () {
        var rec = AI.assignRec ||
          (FG().inventoryAssignments || []).filter(function (a) { return a.id === AI.assignId; })[0];
        var roll = rec && rollById(rec.rollId);
        if (!roll) { bad(); return; }
        newCutSession();
        C.roll = roll; C.woId = w.id; C.assignId = rec.id; C.lineId = rec.lineId;
        C.requiredIn = rec.reservedIn; C.needVerify = true; C.rollVerified = false;
        AI = null;
        go('cut/entry');
      };
    }
  }};
};

/* Assignment detail: full record, release, continue to cut, verify location. */
Screens['assign-inventory/a'] = function (param) {
  var rec = (FG().inventoryAssignments || []).filter(function (a) { return a.id === param; })[0];
  if (!rec) { setTimeout(function () { go('assign-inventory'); }, 0); return { html: '' }; }
  var w = woById(rec.workOrderId);
  var line = w ? lineById(w, rec.lineId) : null;
  var roll = assignableRoll(rec.rollId);
  var active = rec.status === AI_STATUS.RESERVED;
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">ASSIGN INVENTORY</div>' +
    '<div class="label">INVENTORY ASSIGNMENT</div>' +
    '<h1 class="mono">' + esc(rec.id) + '</h1>' +
    '<div>' + aiAssignStatusChip(rec.status) + '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Work Order</span><span class="v mono">' + esc(w ? w.number : rec.workOrderId) + '</span></div>' +
      '<div class="kv"><span class="k">Property</span><span class="v">' + esc(w ? w.property : '—') + '</span></div>' +
      (line ? '<div class="kv"><span class="k">Material Line</span><span class="v">' + esc(line.style) + ' / ' + esc(line.color) + '</span></div>' : '') +
      '<div class="kv"><span class="k">Roll ID</span><span class="v mono">' + esc(rec.rollId) + '</span></div>' +
      '<div class="kv"><span class="k">Required Quantity</span><span class="v num">' + fmtLen(rec.requiredIn) + '</span></div>' +
      '<div class="kv"><span class="k">Reserved Quantity</span><span class="v num">' + fmtLen(rec.reservedIn) + '</span></div>' +
      '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(rec.employee) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(rec.location || '—') +
        (rec.locationVerifiedAt ? ' <span class="stchip st-green">VERIFIED ✓</span>' : '') + '</span></div>' +
      '<div class="kv"><span class="k">Date / Time</span><span class="v">' + fmtDT(rec.at) + '</span></div>' +
      (rec.mismatchApprovedBy ? '<div class="kv"><span class="k">Material Override</span><span class="v">' + esc(rec.mismatchApprovedBy) + '</span></div>' : '') +
      (rec.overApprovedBy ? '<div class="kv"><span class="k">Over-Reservation</span><span class="v">' + esc(rec.overApprovedBy) + '</span></div>' : '') +
      (rec.rollVerifiedAt ? '<div class="kv"><span class="k">Roll Verified</span><span class="v">' + fmtDT(rec.rollVerifiedAt) + ' &middot; ' + esc(rec.rollVerifiedBy || '') + '</span></div>' : '') +
      (rec.releasedAt ? '<div class="kv"><span class="k">Released</span><span class="v">' + fmtDT(rec.releasedAt) + ' &middot; ' + esc(rec.releasedBy || '') + '</span></div>' : '') +
      (rec.consumedAt ? '<div class="kv"><span class="k">Consumed</span><span class="v">' + fmtDT(rec.consumedAt) + ' &middot; ' + esc(rec.consumedBy || '') +
        ' &middot; cut <span class="num">' + fmtLen(rec.actualCutIn || 0) + '</span></span></div>' : '') +
    '</div>' +
    (active ?
      '<button class="btn btn-primary btn-huge" id="a-tocut">&#9986; CONTINUE TO CUT</button>' +
      '<button class="btn btn-huge" id="a-verloc">&#128205; VERIFY LOCATION</button>' +
      '<button class="btn btn-huge" id="a-release" style="color:var(--red)">RELEASE ASSIGNMENT</button>'
    : '') +
    (w ? '<button class="btn" id="a-wo">OPEN WORK ORDER</button>' : '') +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    if (w) $('#a-wo').onclick = function () { go('assign-inventory/wo', w.id); };
    if (!active) return;
    $('#a-verloc').onclick = function () { go('assign-inventory/verify-loc', rec.id); };
    $('#a-tocut').onclick = function () {
      var r = rollById(rec.rollId);
      if (!r) { bad(); return; }
      newCutSession();
      C.roll = r; C.woId = rec.workOrderId; C.assignId = rec.id; C.lineId = rec.lineId;
      C.requiredIn = rec.reservedIn; C.needVerify = true; C.rollVerified = false;
      go('cut/entry');
    };
    $('#a-release').onclick = function () {
      showConfirm({ title: 'Release assignment ' + rec.id + '?',
        body: 'Releases ' + fmtLen(rec.reservedIn) + ' reserved on roll ' + rec.rollId + '. The record is kept as history.',
        okLabel: 'RELEASE' }).then(function (ok) {
        if (!ok) return;
        releaseAssignmentAsync(rec.id, DB.data.currentEmployee).then(function (res) {
          if (!res.ok) { bad(); toast(res.err); return; }
          good(); render();
        }).catch(function (err) {
          bad();
          toast(err && err.code === 'OFFLINE'
            ? 'OFFLINE — RELEASE NOT SYNCED. Reconnect and try again.'
            : ((err && err.message) || 'Release failed.'));
        });
      });
    };
  }};
};

/* Verify the roll's warehouse location with the existing scanner. */
Screens['assign-inventory/verify-loc'] = function (param) {
  var assignId = param, retAssign = null;
  if (param.indexOf('pending/') === 0) {
    var rest = decodeURIComponent(param.slice(8));
    var firstSlash = rest.indexOf('/');
    assignId = null;
    retAssign = { rollId: firstSlash < 0 ? rest : rest.slice(0, firstSlash),
                  backTo: firstSlash < 0 ? null : rest.slice(firstSlash + 1) };
  }
  var rec = assignId ? (FG().inventoryAssignments || []).filter(function (a) { return a.id === assignId; })[0] : null;
  var rollId = rec ? rec.rollId : (retAssign ? retAssign.rollId : null);
  var roll = rollId ? assignableRoll(rollId) : null;
  if (!roll) { setTimeout(function () { go('assign-inventory'); }, 0); return { html: '' }; }
  var loc = isDiscoveredRoll(roll) ? (roll.lastLocation || '') : roll.expectedLocation;
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">VERIFY LOCATION &mdash; <span class="mono">' + esc(roll.id) + '</span></div>' +
    '<h1>Verify location</h1>' +
    '<div class="card"><div class="kv"><span class="k">Expected Location</span><span class="v mono" style="font-size:1.3rem">' +
      esc(loc || '—') + '</span></div></div>' +
    '<div class="card"><div class="label">SCAN LOCATION</div>' +
    '<div class="cambox" id="vl-cam"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="vl-form"><div class="field"><label class="label">OR TYPE THE LOCATION</label>' +
    '<input class="input mono" id="vl-code" autocomplete="off" autocapitalize="characters" placeholder="e.g. 205B"></div>' +
    '<button class="btn btn-primary btn-huge" type="submit">VERIFY</button></form>' +
    '<div id="vl-result"></div></div></div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    mountScannerBox('vl-cam', onCode);
    $('#vl-form').onsubmit = function (e) { e.preventDefault(); onCode($('#vl-code').value); };
    function onCode(code) {
      if (normLoc(code) === normLoc(loc) && normLoc(loc)) {
        good();
        var now = new Date().toISOString();
        if (rec) {
          rec.locationVerifiedAt = now; rec.locationVerifiedBy = DB.data.currentEmployee;
          logAssignEvent('LOCATION_VERIFIED', { user: DB.data.currentEmployee,
            workOrderId: rec.workOrderId, lineId: rec.lineId,
            rollId: roll.id, assignmentId: rec.id,
            detail: 'Location ' + loc + ' verified' });
          DB.save();
        }
        $('#vl-result').innerHTML = '<div class="ok-panel"><div class="big-ok">&#10003; LOCATION VERIFIED</div></div>';
      } else {
        bad();
        $('#vl-result').innerHTML = '<div class="err center">&#10060; LOCATION MISMATCH — scanned "' +
          esc(code) + '", expected "' + esc(loc) + '".</div>';
      }
    }
  }};
};

/* ---------------- boot ---------------- */
function wireShell() {
  $('#hamburger').onclick = openDrawer;
  $('#scrim').onclick = closeDrawer;
  $('#empchip').onclick = function () { go('signin'); };
  document.addEventListener('keydown', function (e) {
    if (e && e.key === 'Escape') closeDrawer();
  });
}

/* ======================================================================
   PORTED FROM FloorGuard prototype (LEGACY / REFERENCE ONLY).
   Mechanical extraction; reviewed before merge. FG(). -> FG().
   ====================================================================== */

/* ---- prototype lines 179-212 ---- */
function rollById(id) {
  return FG().rolls.filter(function (r) { return r.id === id; })[0] || null;
}
/* Location codes are compared case-insensitively with stray spaces trimmed:
   "205b" and " 205B " both mean 205B. The scanned barcode value is
   authoritative — no format or prefix is required. */
function normLoc(s) { return String(s || '').trim().toUpperCase(); }
function rollByBarcode(code) {
  var c = String(code || '').trim().toUpperCase();
  var rolls = FG().rolls;
  var i, r;
  for (i = 0; i < rolls.length; i++) {
    r = rolls[i];
    if (r.barcode.toUpperCase() === c || r.id.toUpperCase() === c) return r;
  }
  /* Manufacturer tags often prefix the roll number (e.g. "01" + roll # on the
     printed tag). Retry with common prefixes stripped before giving up. */
  var stripped = c.replace(/^01/, '');
  if (stripped !== c && stripped) {
    for (i = 0; i < rolls.length; i++) {
      r = rolls[i];
      if (r.barcode.toUpperCase() === stripped || r.id.toUpperCase() === stripped) return r;
    }
  }
  return null;
}
/* System balance = beginning length minus all recorded cuts.
   Cycle counts never change it.
   --- TEMPORARY PILOT FUNCTIONALITY ---
   A supervisor can set roll.testBalanceIn via "SET TEST SYSTEM BALANCE" to stand
   in for the Real Floors system balance during the warehouse pilot. When set,
   it is returned instead of the computed value. To integrate the Real Floors
   API/database later: delete testBalanceIn and have systemBalance() fetch the
   authoritative balance from the backend instead. */

/* ---- prototype lines 213-221 ---- */
function systemBalance(rollId) {
  var roll = rollById(rollId);
  if (!roll) return 0;
  if (roll.testBalanceIn != null) return roll.testBalanceIn; /* TEMPORARY PILOT: Real Floors API replaces this */
  /* Run 4 shared mode: the backend is the source of truth — the authoritative
     balance hydrated from PostgreSQL, not a local re-derivation. */
  if (typeof Repository !== 'undefined' && Repository.mode === 'shared' && roll.sharedExpectedIn != null)
    return roll.sharedExpectedIn;
  var cuts = FG().cuts.filter(function (c) { return c.rollId === rollId; });
  var used = cuts.reduce(function (s, c) { return s + c.inches; }, 0);
  return roll.beginningIn - used;
}
function isTestBalance(roll) { return !!(roll && roll.testBalanceIn != null); }

/* ---- prototype lines 226-229 ---- */
function isMeasuredCount(c) { return !!(c && (c.measured || c.physicalIn != null)); }

/* Rolls whose latest physical measurement differs from the expected balance.
   Shared by the Discrepancies screen and the dashboard badge so both agree. */

/* ---- prototype lines 230-260 ---- */
function discrepancyRolls() {
  var latest = {};
  FG().counts.forEach(function (c) {
    if (!isMeasuredCount(c)) return;
    if (!latest[c.rollId] || new Date(c.at) > new Date(latest[c.rollId].at)) latest[c.rollId] = c;
  });
  return Object.keys(latest).map(function (k) { return latest[k]; })
    .filter(function (c) { return c.diffIn !== 0; })
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
}

/* ---------------- Roll data model ------------------------------------------------
   Roll ID, Barcode, Style, Color, Width, Current Location live on the roll record.
   CURRENT EXPECTED BALANCE is never stored — it is calculated from transactions:
     starting balance (beginningIn) - sum of cuts = expected balance
   (or the temporary pilot testBalanceIn override when a supervisor set one).
   MEASURED BALANCE (MB): roll.measuredIn / measuredAt / measuredBy are stamped
   every time a worker physically measures the roll during a cycle count.
   Cut History = FG().cuts for the roll. Cycle Count History = FG().counts
   for the roll. History is append-only: records are never edited or deleted.
   A discrepancy NEVER changes the expected balance — it is recorded and queued
   for supervisor review on the Discrepancies screen. */

/* ---------------- Cut transaction service (integration seam) ----------------------
   ALL cut transactions go through CutService.recordCut() — the prototype UI and
   any future integration alike. Manual entry is the prototype path.
   FUTURE REAL FLOORS INTEGRATION: when Real Floors records an order/cut, an
   approved API/data integration calls CutService.recordCut() with the cut
   details, and FloorGuard updates the expected balance automatically — the
   employee must NOT enter the same cut twice. Keep this function separate from
   the UI so the integration can replace manual entry without touching screens.

/* ---- prototype lines 262-310 ---- */
var CutService = {
  /* opts: { rollId, order, cutIn, employee, location }
     Returns { ok:true, rec } or { ok:false, err }. */
  recordCut: function (opts) {
    var roll = rollById(opts.rollId);
    if (!roll) return { ok: false, err: 'Roll not found.' };
    var order = String(opts.order || '').trim().toUpperCase();
    if (!order) return { ok: false, err: 'Enter the order number.' };
    var cutIn = Math.round(Number(opts.cutIn));
    if (!isFinite(cutIn) || cutIn <= 0) return { ok: false, err: 'Cut length must be more than zero.' };
    var prevIn = systemBalance(roll.id);
    if (cutIn > prevIn) return { ok: false, err: 'Cut (' + fmtLen(cutIn) + ') exceeds the current balance (' + fmtLen(prevIn) + ').' };
    var now = new Date();
    var rec = {
      id: 'K' + Date.now().toString(36).toUpperCase(),
      rollId: roll.id, barcode: roll.barcode, order: order,
      prevIn: prevIn, inches: cutIn, newIn: prevIn - cutIn,
      location: opts.location || roll.expectedLocation,
      by: opts.employee || DB.data.currentEmployee,
      at: now.toISOString(), date: now.toLocaleDateString(), time: fmtTime(now.toISOString())
    };
    FG().cuts.push(rec); /* append-only: cut history is never edited or deleted */
    /* Keep a supervisor's temporary test balance in sync with recorded cuts. */
    if (roll.testBalanceIn != null) roll.testBalanceIn = Math.max(0, roll.testBalanceIn - cutIn);
    DB.save();
    return { ok: true, rec: rec };
  },
  recentOrders: function () {
    var seen = {}, out = [];
    FG().cuts.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); })
      .forEach(function (c) {
        if (c.order && !seen[c.order]) { seen[c.order] = 1; out.push(c.order); }
      });
    return out.slice(0, 8);
  }
};
function countsForRoll(rollId) {
  return FG().counts
    .filter(function (c) { return c.rollId === rollId; })
    .sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
}
function recentCountForRoll(rollId, withinMs) {
  var list = countsForRoll(rollId).filter(function (c) {
    return (Date.now() - new Date(c.at).getTime()) <= withinMs;
  });
  return list.length ? list[list.length - 1] : null;
}

/* ---------------- formatting ---------------------------------------------- */

/* ---- prototype lines 317-347 ---- */
function fmtLen(inches) {
  var n = Math.round(inches);
  var ft = Math.floor(n / 12), inch = n % 12;
  return ft + "' " + inch + '"';
}
/* signed difference -> -3" / +2' 4" / 0" */
function fmtDiff(d) {
  d = Math.round(d);
  if (d === 0) return '0"';
  var s = d < 0 ? '-' : '+';
  var a = Math.abs(d);
  if (a < 12) return s + a + '"';
  return s + fmtLen(a);
}
function diffCls(d) { return d === 0 ? 'diff-zero' : (d < 0 ? 'diff-neg' : 'diff-pos'); }
function fmtWidth(wIn) {
  return (wIn % 12 === 0) ? (wIn / 12) + ' FT' : fmtLen(wIn);
}
function fmtDT(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function isToday(iso) {
  var d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/* ---------------- status --------------------------------------------------- */

/* ---- prototype lines 348-401 ---- */
var STATUS = {
  MATCH:            { label: 'MATCH',            chip: 'st-green'  },
  SHORT:            { label: 'SHORT',            chip: 'st-red'    },
  OVER:             { label: 'OVER',             chip: 'st-yellow' },
  LOCATION_MISMATCH:{ label: 'LOCATION MISMATCH',chip: 'st-red'    },
  NEEDS_REVIEW:     { label: 'NEEDS REVIEW',     chip: 'st-yellow' },
  LOCATION_ISSUE:   { label: 'LOCATION ISSUE',   chip: 'st-red'    },
  NEWLY_DISCOVERED: { label: 'NEWLY DISCOVERED', chip: 'st-blue'   },
  COLLECTED:        { label: 'COLLECTED',        chip: 'st-blue'   }
};
function statusChip(status) {
  /* Accept both key form (LOCATION_ISSUE) and label form ('LOCATION ISSUE'),
     since status producers use the human-readable label. */
  var m = STATUS[status] || STATUS[String(status).replace(/ /g, '_')] || STATUS.NEEDS_REVIEW;
  return '<span class="stchip ' + m.chip + '">' + m.label + '</span>';
}
/* Location mismatch always wins over the balance comparison. */
function computeStatus(roll, scannedLoc, physicalIn, flagged) {
  if (normLoc(scannedLoc) !== normLoc(roll.expectedLocation)) {
    return flagged ? 'NEEDS_REVIEW' : 'LOCATION_MISMATCH';
  }
  var diff = physicalIn - systemBalance(roll.id);
  if (diff === 0) return 'MATCH';
  return diff < 0 ? 'SHORT' : 'OVER';
}

/* ---------------- device feedback (guarded) -------------------------------- */
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern || 60); } catch (e) {}
}
function beep(freq, dur) {
  try {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    var ctx = new C();
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq || 880;
    g.gain.value = 0.12;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    var d = dur || 0.12;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d);
    o.stop(ctx.currentTime + d + 0.03);
  } catch (e) {}
}
function flash(color) {
  var f = document.getElementById('flash');
  if (!f) return;
  f.className = 'show ' + color;
  setTimeout(function () { f.className = ''; }, 380);
}
function good() { beep(880, 0.12); buzz(60); flash('green'); }
function bad()  { beep(220, 0.28); buzz([90, 50, 90]); flash('red'); }
function warn() { beep(520, 0.18); buzz(140); flash('yellow'); }

/* ---- prototype lines 405-539 ---- */
/* ---------------- camera barcode scanner -----------------------------------
   Uses getUserMedia + BarcodeDetector when the device supports them.
   Camera is a convenience only: big manual entry is ALWAYS offered, because
   desktops, denied permissions, and gloves must never block a count. */
var Scanner = {
  stream: null,
  stopFlag: false,
  zxReader: null,

  cameraAvailable: function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  },

  /* True when ANY barcode reader exists: the built-in API or our bundled ZXing. */
  hasReader: function () {
    return ('BarcodeDetector' in window) ||
      !!(window.ZXing && ZXing.BrowserMultiFormatReader);
  },

  start: function (videoEl, onCode) {
    var self = this;
    self.stop();
    self.stopFlag = false;
    if (!self.cameraAvailable()) return Promise.resolve({ ok: false, reason: 'no-camera-api' });
    /* Check for a barcode-reader API BEFORE asking for the camera: without one
       the preview can't scan anything, so skip the permission prompt entirely
       instead of flashing the user's own video and then failing. */
    if (!self.hasReader()) return Promise.resolve({ ok: false, reason: 'no-detector' });
    /* No built-in reader (older iOS) but our bundled ZXing is present. */
    if (!('BarcodeDetector' in window)) return self.startZxing(videoEl, onCode);
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (stream) {
        self.stream = stream;
        videoEl.srcObject = stream;
        return videoEl.play().catch(function () {});
      })
      .then(function () {
        var det = null;
        try {
          det = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar'] });
        } catch (e1) {
          try { det = new BarcodeDetector(); }
          catch (e2) { self.stop(); return { ok: false, reason: 'detector-init' }; }
        }
        var fails = 0, hintShown = false;
        var tick = function () {
          if (self.stopFlag) return;
          var p;
          try { p = det.detect(videoEl); }
          catch (e) { requestAnimationFrame(tick); return; }
          p.then(function (codes) {
            if (self.stopFlag) return;
            fails = 0;
            if (codes && codes.length && codes[0].rawValue) {
              self.stop();
              onCode(codes[0].rawValue);
            } else {
              requestAnimationFrame(tick);
            }
          }).catch(function () {
            if (self.stopFlag) return;
            fails++;
            if (fails >= 25 && !hintShown) {
              hintShown = true;
              var box = videoEl.parentNode;
              if (box) {
                var d = document.createElement('div');
                d.className = 'camnote';
                d.innerHTML = 'Having trouble reading &mdash; you can type the code or tap a DEMO chip below.';
                box.appendChild(d);
              }
            }
            requestAnimationFrame(tick);
          });
        };
        tick();
        return { ok: true, mode: 'camera' };
      })
      .catch(function () { self.stop(); return { ok: false, reason: 'denied' }; });
  },

  /* Fallback path for devices without the built-in BarcodeDetector (older iOS):
     decode with the bundled ZXing library instead. */
  startZxing: function (videoEl, onCode) {
    var self = this;
    self.stop();
    self.stopFlag = false;
    var reader;
    try {
      reader = new ZXing.BrowserMultiFormatReader();
    } catch (e) {
      return Promise.resolve({ ok: false, reason: 'detector-init' });
    }
    self.zxReader = reader;
    var p;
    try {
      p = reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        videoEl,
        function (result, err) {
          if (self.stopFlag) return;
          if (result && result.getText) {
            var txt = result.getText();
            if (txt) { self.stop(); onCode(txt); }
          }
          /* err is routine (no barcode in this frame); ignore it. */
        }
      );
    } catch (e) {
      self.stop();
      return Promise.resolve({ ok: false, reason: 'detector-init' });
    }
    return Promise.resolve(p).then(
      function () { return { ok: true, mode: 'camera-zxing' }; },
      function (e) {
        self.stop();
        var denied = e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError' || e.name === 'OverconstrainedError');
        return { ok: false, reason: denied ? 'denied' : 'detector-init' };
      }
    );
  },

  stop: function () {
    this.stopFlag = true;
    if (this.zxReader) {
      try { this.zxReader.reset(); } catch (e) {}
      this.zxReader = null;
    }
    if (this.stream) {
      try { this.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      this.stream = null;
    }
  }
};

/* ---- prototype lines 541-556 ---- */
var S = null;          /* active count session */
var lastSavedId = null;

function newSession() {
  S = { roll: null, scannedLoc: null, physicalIn: null, flagged: false };
}
/* Cut-transaction session. */
var C = null;
function newCutSession() {
  /* Run 3: assignId/lineId/requiredIn + needVerify carry an inventory
     assignment into the cut flow. rollVerified gates SAVE CUT. */
  C = { roll: null, order: '', cutIn: null, woId: null,
        assignId: null, lineId: null, requiredIn: null,
        needVerify: false, rollVerified: false };
}
/* Rapid cycle-count session: one active location, then roll after roll. */
var R = null;
function newRapid() {
  R = { activeLoc: null, scan: null, lastMsg: null };
}

/* ---- prototype lines 604-607 ---- */
function needRoll()   { if (!S || !S.roll) { go('dashboard'); return false; } return true; }
function needLoc()    { if (!needRoll() || !S.scannedLoc) { go('dashboard'); return false; } return true; }
function needBalance(){ if (!needLoc() || S.physicalIn == null) { go('dashboard'); return false; } return true; }

/* ---- prototype lines 677-732 ---- */
Screens['count/standard'] = function () {
  if (!S) newSession();
  var chips = FG().rolls.map(function (r) {
    return '<button class="demochip" data-code="' + esc(r.barcode) + '">' + esc(r.barcode) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">STEP 1 OF 4 &mdash; SCAN ROLL</div>' +
    '<h1>Scan roll barcode</h1>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE BARCODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
  }};

  function onCode(code) {
    var roll = rollByBarcode(code);
    if (!roll) {
      bad();
      var norm0 = normalizeBarcode(code);
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; ROLL NOT FOUND<br><span style="font-size:1rem">"' +
        esc(code) + '" is not in the system.</span></div>' +
        '<button class="btn btn-free" id="todisc">🆓 OPEN IN FREE RUN (DISCOVERY)</button>';
      $('#todisc').onclick = function () {
        newFreeRun();
        if (norm0) F.firstScan = norm0;
        go('count/free/loc');
      };
      return;
    }
    good();
    S.roll = roll;
    var scanned = String(code || '').trim().toUpperCase();
    var scannedRow = (scanned && scanned !== roll.barcode.toUpperCase() && scanned !== roll.id.toUpperCase())
      ? '<div class="kv"><span class="k">Scanned code</span><span class="v mono">' + esc(scanned) + '</span></div>'
      : '';
    $('#result').innerHTML =
      '<div class="ok-panel"><div class="big-ok">&#9989; ROLL IDENTIFIED</div>' +
      scannedRow +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Current Balance</span><span class="v num">' + fmtLen(systemBalance(roll.id)) + '</span></div>' +
      '</div>' +
      '<button class="btn btn-primary btn-huge" id="cont">CONTINUE &rarr; SCAN LOCATION</button>';
    $('#cont').onclick = function () { go('count/standard/loc'); };
    $('#cont').scrollIntoView(false);
  }
};

/* Shared camera-box wiring used by both scan steps. */

/* ---- prototype lines 733-811 ---- */
function mountScannerBox(boxId, onCode) {
  var box = document.getElementById(boxId);
  if (!Scanner.cameraAvailable()) {
    box.innerHTML = '<div class="camnote">This device has no camera.<br>Type the code or tap a DEMO chip below.</div>';
    return;
  }
  if (!Scanner.hasReader()) {
    /* No barcode-reader API on this device and the bundled fallback failed to
       load: don't prompt for the camera — it couldn't scan anyway. Manual
       entry and the DEMO chips are the way through. */
    box.innerHTML = '<div class="camnote">&#9888;&#65039; Auto-scan isn\'t supported on this iPhone\'s iOS version.<br>Type the code or tap a DEMO chip below &mdash; no camera needed.</div>';
    return;
  }
  box.innerHTML = '<video id="scanvideo" playsinline muted></video><div class="scanline"></div>';
  var video = document.getElementById('scanvideo');
  Scanner.start(video, onCode).then(function (res) {
    if (!res.ok) {
      var msg = res.reason === 'denied'
        ? 'Camera permission was denied. Allow camera access in Settings,<br>or type the code / tap a DEMO chip below.'
        : 'The barcode reader failed to start on this device.<br>Type the code or tap a DEMO chip below.';
      box.innerHTML = '<div class="camnote">' + msg + '</div>';
    }
  });
}

/* ---------------- SCAN LOCATION (step 2) ------------------------------------- */
Screens['count/standard/loc'] = function () {
  if (!needRoll()) return { html: '' };
  S.scannedLoc = null;
  /* Demo/test values only — real locations come from the scanned barcode. */
  var chips = ['205A', '205B', '206A', '206B', '204A', '204B'].map(function (l) {
    return '<button class="demochip" data-code="' + esc(l) + '">' + esc(l) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">STEP 2 OF 4 &mdash; SCAN LOCATION</div>' +
    '<h1>Scan the location barcode</h1>' +
    '<p class="hint">Roll <b class="mono">' + esc(S.roll.id) + '</b> &mdash; scan the location tag where it sits.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE LOCATION CODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. 205B">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
  }};

  function onCode(code) {
    var loc = normLoc(code);
    if (!loc) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; EMPTY SCAN &mdash; try again.</div>';
      return;
    }
    good();
    S.scannedLoc = loc;
    $('#result').innerHTML =
      '<div class="ok-panel"><div class="big-ok">&#9989; LOCATION VERIFIED</div>' +
      '<div class="kv"><span class="k">Scanned</span><span class="v mono" style="font-size:1.5rem">' + esc(loc) + '</span></div>' +
      '</div>' +
      '<button class="btn btn-primary btn-huge" id="cont">CONTINUE &rarr; ENTER BALANCE</button>';
    $('#cont').onclick = function () {
      var dup = recentCountForRoll(S.roll.id, 24 * 3600 * 1000);
      go(dup ? 'count/standard/dup' : 'count/standard/balance');
    };
    $('#cont').scrollIntoView(false);
  }
};

/* ---------------- SEARCH ROLL ------------------------------------------------- */

/* ---- prototype lines 812-874 ---- */
Screens['rolls/search'] = function () {
  var html =
    '<div class="screen">' +
    '<div class="step-head">FIND A ROLL</div>' +
    '<h1>Search rolls</h1>' +
    '<div class="field"><input class="input" id="q" autocomplete="off" placeholder="Roll #, style, color, location&hellip;"></div>' +
    '<div id="results"></div>' +
    '</div>';
  return { html: html, mount: function () {
    var renderResults = function () {
      var q = $('#q').value.trim().toLowerCase();
      var list = FG().rolls.filter(function (r) {
        if (!q) return true;
        return (r.id + ' ' + r.style + ' ' + r.color + ' ' + r.expectedLocation + ' ' + r.manufacturer)
          .toLowerCase().indexOf(q) >= 0;
      });
      $('#results').innerHTML = list.length ? list.map(function (r) {
        return '<button class="rowbtn" data-roll="' + esc(r.id) + '">' +
          '<div class="rhead"><b class="mono">' + esc(r.id) + '</b>' + lastCountChip(r.id) + '</div>' +
          '<div class="sub">' + esc(r.style) + ' &middot; ' + esc(r.color) + ' &middot; ' + esc(r.expectedLocation) +
          ' &middot; bal ' + fmtLen(systemBalance(r.id)) + '</div></button>';
      }).join('') : '<p class="hint center">No rolls match.</p>';
      Array.prototype.forEach.call(document.querySelectorAll('[data-roll]'), function (b) {
        b.onclick = function () { go('roll', b.getAttribute('data-roll')); };
      });
    };
    $('#q').addEventListener('input', renderResults);
    renderResults();
    $('#q').focus();
  }};
  function lastCountChip(rollId) {
    var c = countsForRoll(rollId);
    if (!c.length) return '<span class="stchip" style="background:var(--line);color:var(--muted)">NOT COUNTED</span>';
    return statusChip(c[c.length - 1].status);
  }
};

/* ---------------- DUPLICATE COUNT PROTECTION ---------------------------------- */
Screens['count/standard/dup'] = function () {
  if (!needLoc()) return { html: '' };
  var dup = recentCountForRoll(S.roll.id, 24 * 3600 * 1000);
  if (!dup) { setTimeout(function () { go('count/standard/balance'); }, 0); return { html: '' }; }
  var html =
    '<div class="screen">' +
    '<div class="warn-panel" style="background:var(--yellow-dark);border-color:var(--yellow)">' +
      '<h1>&#9888; THIS ROLL WAS<br>ALREADY COUNTED</h1>' +
      '<div class="kv"><span class="k">Last Count</span><span class="v">' + fmtDT(dup.at) + '</span></div>' +
      '<div class="kv"><span class="k">By</span><span class="v">' + esc(dup.employee) + '</span></div>' +
      '<div class="kv"><span class="k">Status</span><span class="v">' + statusChip(dup.status) + '</span></div>' +
    '</div>' +
    '<h2 class="center">Count again?</h2>' +
    '<div class="btn-row">' +
      '<button class="btn btn-green btn-huge" id="yes">YES</button>' +
      '<button class="btn btn-red btn-huge" id="cancel">CANCEL</button>' +
    '</div></div>';
  return { html: html, mount: function () {
    warn();
    $('#yes').onclick = function () { go('count/standard/balance'); };
    $('#cancel').onclick = function () { S = null; go('dashboard'); };
  }};
};

/* ---------------- ENTER PHYSICAL BALANCE (step 3) ------------------------------ */

/* ---- prototype lines 875-984 ---- */
Screens['count/standard/balance'] = function () {
  if (!needLoc()) return { html: '' };
  var roll = S.roll, sys = systemBalance(roll.id);
  var html =
    '<div class="screen">' +
    '<div class="step-head">STEP 3 OF 4 &mdash; PHYSICAL BALANCE</div>' +
    '<h1>Physical balance</h1>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(normLoc(S.scannedLoc)) + '</span></div>' +
      '<div class="kv"><span class="k">System Balance' +
        (isTestBalance(roll) ? ' <span class="stchip st-yellow">TEST</span>' : '') +
        '</span><span class="v num" style="font-size:1.5rem">' + fmtLen(sys) + '</span></div>' +
    '</div>' +
    '<div class="field"><label class="label">AMOUNT OF CARPET PHYSICALLY ON THE ROLL</label></div>' +
    '<div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">FEET</label>' +
      '<input class="input num balfield" id="ft" inputmode="numeric" autocomplete="off" placeholder="0"></div>' +
      '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
      '<input class="input num balfield" id="inch" inputmode="decimal" autocomplete="off" placeholder="0"></div>' +
    '</div>' +
    '<div class="big-readout num" id="combined">= 0\' 0"</div>' +
    '<div class="err" id="balerr" hidden></div>' +
    '<button class="btn btn-primary btn-huge" id="cont">CONTINUE &rarr; REVIEW</button>' +
    '</div>';
  return { html: html, mount: function () {
    var update = function () {
      var ft = parseFloat($('#ft').value) || 0, inch = parseFloat($('#inch').value) || 0;
      if (ft < 0 || inch < 0 || isNaN(ft) || isNaN(inch)) { $('#combined').textContent = '= —'; return; }
      $('#combined').textContent = '= ' + fmtLen(Math.round(ft * 12 + inch));
    };
    $('#ft').addEventListener('input', update);
    $('#inch').addEventListener('input', update);
    $('#cont').onclick = function () {
      var ft = parseFloat($('#ft').value), inch = parseFloat($('#inch').value);
      var err = '';
      if ($('#ft').value.trim() === '' && $('#inch').value.trim() === '') err = 'Enter feet and/or inches.';
      else if (isNaN(ft) || isNaN(inch) || ft < 0 || inch < 0) err = 'Numbers must be zero or more.';
      if (err) { bad(); var e = $('#balerr'); e.textContent = err; e.hidden = false; return; }
      S.physicalIn = Math.round(ft * 12 + inch);
      good();
      go(normLoc(S.scannedLoc) !== normLoc(S.roll.expectedLocation) ? 'count/standard/mismatch' : 'count/standard/confirm');
    };
  }};
};

/* ---------------- CONFIRM (step 4, location matches) -------------------------- */
Screens['count/standard/confirm'] = function () {
  if (!needBalance()) return { html: '' };
  var roll = S.roll, sys = systemBalance(roll.id), diff = S.physicalIn - sys;
  var status = computeStatus(roll, S.scannedLoc, S.physicalIn, false);
  var html =
    '<div class="screen">' +
    '<div class="step-head">STEP 4 OF 4 &mdash; CONFIRM COUNT</div>' +
    '<h1>Review before saving</h1>' +
    '<div class="card">' +
      kv('Roll #', '<span class="mono">' + esc(roll.id) + '</span>') +
      kv('Style', esc(roll.style)) +
      kv('Color', esc(roll.color)) +
      kv('Width', fmtWidth(roll.widthIn)) +
      kv('System Balance', '<span class="num">' + fmtLen(sys) + '</span>') +
      kv('Physical Balance', '<span class="num">' + fmtLen(S.physicalIn) + '</span>') +
      kv('Difference', '<span class="' + diffCls(diff) + ' num">' + fmtDiff(diff) + '</span>') +
      kv('Expected Location', '<span class="mono">' + esc(roll.expectedLocation) + '</span>') +
      kv('Scanned Location', '<span class="mono">' + esc(S.scannedLoc) + '</span>') +
      kv('Status', statusChip(status)) +
      kv('Employee', esc(DB.data.currentEmployee)) +
    '</div>' +
    '<button class="btn btn-green btn-huge" id="submit">SUBMIT COUNT</button>' +
    '<button class="linklike" id="back">&larr; go back and re-measure</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#submit').onclick = function () { submitCount(false); };
    $('#back').onclick = function () { go('count/standard/balance'); };
  }};
  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
};

/* ---------------- LOCATION MISMATCH warning ----------------------------------- */
Screens['count/standard/mismatch'] = function () {
  if (!needBalance()) return { html: '' };
  if (normLoc(S.scannedLoc) === normLoc(S.roll.expectedLocation)) { setTimeout(function () { go('count/standard/confirm'); }, 0); return { html: '' }; }
  var roll = S.roll;
  var html =
    '<div class="screen">' +
    '<div class="warn-panel">' +
      '<h1>&#9888; LOCATION<br>MISMATCH</h1>' +
      '<p style="color:#fecaca">This roll is <b>not</b> where the system expects it.<br>The location will <b>NOT</b> be changed automatically.</p>' +
      '<div class="vs">' +
        '<div><div class="k">EXPECTED LOCATION</div><div class="v mono">' + esc(roll.expectedLocation) + '</div></div>' +
        '<div><div class="k">SCANNED LOCATION</div><div class="v mono">' + esc(S.scannedLoc) + '</div></div>' +
      '</div>' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
    '</div>' +
    '<button class="btn btn-red btn-huge" id="save-mismatch">SAVE AS LOCATION MISMATCH</button>' +
    '<button class="btn btn-yellow btn-huge" id="flag">&#9888; FLAG FOR SUPERVISOR REVIEW</button>' +
    '<button class="linklike" id="goback">&larr; go back and re-scan the location</button>' +
    '</div>';
  return { html: html, mount: function () {
    bad();
    $('#save-mismatch').onclick = function () { submitCount(false); };
    $('#flag').onclick = function () { submitCount(true); };
    $('#goback').onclick = function () { S.scannedLoc = null; go('count/standard/loc'); };
  }};
};

/* ---------------- submit + saved --------------------------------------------- */

/* Work-order options for the cut screen: open orders first. */
function woOptions(selectedId) {
  var wos = (FG().workOrders || []).slice().sort(function (a, b) {
    var rank = function (w) { return w.opStatus === 'COMPLETE' ? 2 : (w.opStatus === 'IN_PROGRESS' ? 0 : 1); };
    return rank(a) - rank(b);
  });
  return wos.map(function (w) {
    return '<option value="' + esc(w.id) + '"' + (w.id === selectedId ? ' selected' : '') + '>' +
      esc(w.number) + ' \u2014 ' + esc(w.property) + ' (' + esc(w.opStatus) + ')</option>';
  }).join('');
}

/* ---- prototype lines 985-1187 ---- */
function submitCount(flagged) {
  var roll = S.roll;
  var sys = systemBalance(roll.id);
  var diff = S.physicalIn - sys;
  var status = computeStatus(roll, S.scannedLoc, S.physicalIn, flagged);
  /* Run 4 shared mode: atomic backend write (record + MB stamp + history +
     audit), then quiet refresh so the authoritative record shows up. */
  if (dataMode() === 'shared' && typeof SharedRepo !== 'undefined') {
    sharedRecordCount({
      rollId: roll.id, scannedLocation: S.scannedLoc, expectedIn: sys,
      physicalIn: S.physicalIn, status: status,
      employee: DB.data.currentEmployee, note: flagged ? 'Flagged for review' : null
    }).then(function (r) {
      S = null;
      lastSavedId = r.recordId;
      if (status === 'MATCH') good(); else if (status === 'NEEDS_REVIEW') warn(); else bad();
      go('count/standard/saved', r.recordId);
    }).catch(function (err) {
      bad();
      countOffline(err, { kind: 'count', payload: {
        rollId: roll.id, scannedLocation: S.scannedLoc, expectedIn: sys,
        physicalIn: S.physicalIn, status: status,
        employee: DB.data.currentEmployee, note: flagged ? 'Flagged for review' : null,
        warehouseId: Repository.config.warehouseId
      }});
    });
    return;
  }
  var now = new Date();
  var rec = {
    id: 'C' + Date.now().toString(36).toUpperCase(),
    rollId: roll.id, barcode: roll.barcode, style: roll.style, color: roll.color, widthIn: roll.widthIn,
    expectedLocation: roll.expectedLocation, scannedLocation: S.scannedLoc,
    expectedIn: sys, physicalIn: S.physicalIn, diffIn: diff,
    measured: true, /* MB: worker physically measured this roll */
    employee: DB.data.currentEmployee, at: now.toISOString(),
    date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
    status: status, flagged: !!flagged
  };
  FG().counts.push(rec); /* append-only: records are never edited or deleted */
  /* Stamp the roll's measured-balance fields so supervisors can distinguish
     the calculated/system balance from the last physical measurement. */
  roll.measuredIn = S.physicalIn;
  roll.measuredAt = rec.at;
  roll.measuredBy = rec.employee;
  DB.save();
  S = null;
  lastSavedId = rec.id;
  if (status === 'MATCH') good(); else if (status === 'NEEDS_REVIEW') warn(); else bad();
  go('count/standard/saved', rec.id);
}

/* Run 4: shared-mode count write + refresh, resolving the authoritative
   record id. Discovered rolls are upserted first (FK-safe). */
function sharedRecordCount(o) {
  var ensure = (o.discovered && o.roll && typeof SharedRepo !== 'undefined')
    ? SharedRepo.ensureRoll(o.roll) : Promise.resolve();
  return ensure.then(function () {
    return SharedRepo.recordCycleCount(o);
  }).then(function (r) {
    return Repository.refresh({ quiet: true }).then(function () { return r; });
  });
}
/* Run 4: offline count handling — queue for explicit retry, never pretend
   the backend accepted it. */
function countOffline(err, outboxItem) {
  if (err && (err.code === 'OFFLINE' || err.code === 'NETWORK') && typeof Sync !== 'undefined') {
    Sync.queue(outboxItem);
    Sync.set('OFFLINE');
    toast('OFFLINE — COUNT NOT SYNCED. Reconnect and retry from Settings.');
  } else {
    toast((err && err.message) || 'Count failed.');
  }
}

/* ---------------- CUT TRANSACTION MODE -------------------------------------------
   SCAN ROLL -> SHOW CURRENT BALANCE -> ORDER NUMBER -> CUT LENGTH ->
   NEW BALANCE -> SAVE CUT -> READY STATE.
   The barcode identifies the ROLL only; the balance lives in the database and is
   recalculated from the cut history, so the same barcode stays on the roll for
   its whole life. All writes go through CutService.recordCut() (the Real Floors
   integration seam). The scanner implementation below is untouched — the shared
   mountScannerBox wiring is reused, not rebuilt. */
Screens['cut/scan'] = function () {
  if (!C) newCutSession();
  var chips = FG().rolls.map(function (r) {
    return '<button class="demochip" data-code="' + esc(r.barcode) + '">' + esc(r.barcode) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">CUT TRANSACTION &mdash; SCAN ROLL</div>' +
    '<h1>Scan roll barcode</h1>' +
    '<p class="hint">Scan the roll to cut. The barcode identifies the roll &mdash; the current balance comes from the database.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE BARCODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
  }};

  function onCode(code) {
    var roll = rollByBarcode(code);
    if (!roll) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; ROLL NOT FOUND<br><span style="font-size:1rem">"' +
        esc(code) + '" is not in the system. Try again.</span></div>';
      return;
    }
    good();
    C.roll = roll;
    $('#result').innerHTML =
      '<div class="ok-panel"><div class="big-ok">&#9989; ROLL IDENTIFIED</div>' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Current Balance</span><span class="v num" style="font-size:1.5rem">' + fmtLen(systemBalance(roll.id)) + '</span></div>' +
      '</div>' +
      '<button class="btn btn-primary btn-huge" id="cont">CONTINUE &rarr; ENTER CUT</button>';
    $('#cont').onclick = function () { go('cut/entry'); };
    $('#cont').scrollIntoView(false);
  }
};

Screens['cut/entry'] = function () {
  if (!C || !C.roll) { setTimeout(function () { go('cut/scan'); }, 0); return { html: '' }; }
  var roll = C.roll, bal = systemBalance(roll.id);
  var preWo = C.woId || '';
  var orderOpts = CutService.recentOrders().map(function (o) {
    return '<option value="' + esc(o) + '">';
  }).join('');
  /* Run 3: assignment banner + roll verification when cutting from an
     inventory assignment. The worker verifies the physical roll barcode
     before cutting — the assignment is not consumed until the cut saves. */
  var assignBanner = '';
  if (C.assignId) {
    var awo = C.woId ? woById(C.woId) : null;
    assignBanner =
      '<div class="card" style="border:2px solid var(--blue)">' +
      '<div class="label">CUTTING FROM INVENTORY ASSIGNMENT</div>' +
      '<div class="kv"><span class="k">Work Order</span><span class="v mono">' + esc(awo ? awo.number : (C.woId || '—')) + '</span></div>' +
      '<div class="kv"><span class="k">Roll</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Required</span><span class="v num">' + fmtLen(C.requiredIn || 0) + '</span></div>' +
      '<div class="kv"><span class="k">Current Balance</span><span class="v num">' + fmtLen(bal) + '</span></div></div>' +
      '<div class="card" id="verifycard"><div class="label">VERIFY ROLL BARCODE</div>' +
      '<div class="cambox" id="cut-verifybox"><div class="camnote">Starting camera&hellip;</div></div>' +
      '<form id="cut-verifyform"><div class="field">' +
      '<input class="input mono" id="cut-verifycode" autocomplete="off" autocapitalize="characters" placeholder="Scan or type the roll barcode"></div>' +
      '<button class="btn btn-primary" type="submit">VERIFY ROLL</button></form>' +
      '<div id="cut-verifyresult"></div></div>';
  }
  var preFt = '', preIn = '';
  if (C.requiredIn) { preFt = String(Math.floor(C.requiredIn / 12)); preIn = String(C.requiredIn % 12); }
  var html =
    '<div class="screen">' +
    '<div class="step-head">CUT TRANSACTION &mdash; ENTER CUT</div>' +
    '<h1>Record a cut</h1>' + assignBanner +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(roll.expectedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">Current Balance' +
        (isTestBalance(roll) ? ' <span class="stchip st-yellow">TEST</span>' : '') +
        '</span><span class="v num" style="font-size:1.5rem">' + fmtLen(bal) + '</span></div>' +
    '</div>' +
    '<div class="field"><label class="label" for="wo">WORK ORDER (optional)</label>' +
      '<select class="input" id="wo"><option value="">&#8212; none &#8212;</option>' + woOptions(preWo) + '</select></div>' +
    '<div class="field"><label class="label" for="order">ORDER NUMBER</label>' +
      '<input class="input mono" id="order" list="orders" autocomplete="off" autocapitalize="characters" placeholder="e.g. XS024536">' +
      '<datalist id="orders">' + orderOpts + '</datalist></div>' +
    '<div class="field"><label class="label">CUT LENGTH</label></div>' +
    '<div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">FEET</label>' +
      '<input class="input num" id="cft" inputmode="numeric" autocomplete="off" placeholder="0" value="' + esc(preFt) + '"></div>' +
      '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
      '<input class="input num" id="cin" inputmode="decimal" autocomplete="off" placeholder="0" value="' + esc(preIn) + '"></div>' +
    '</div>' +
    '<div class="card"><div class="kv"><span class="k">NEW EXPECTED BALANCE</span>' +
      '<span class="v num" id="newbal" style="font-size:1.5rem">= ' + fmtLen(bal) + '</span></div></div>' +
    '<div class="err" id="cuterr" hidden></div>' +
    '<button class="btn btn-primary btn-huge" id="savecut">&#9986; SAVE CUT</button>' +
    '<button class="btn" id="cutcancel">CANCEL</button>' +
    '</div>';
  return { html: html, mount: function () {
    var update = function () {
      var ft = parseFloat($('#cft').value) || 0, inch = parseFloat($('#cin').value) || 0;
      if (ft < 0 || inch < 0 || isNaN(ft) || isNaN(inch)) { $('#newbal').textContent = '= —'; return; }
      var cut = Math.round(ft * 12 + inch);
      $('#newbal').textContent = '= ' + fmtLen(Math.max(0, bal - cut));
      $('#newbal').style.color = cut > bal ? 'var(--red)' : '';
    };
    $('#cft').addEventListener('input', update);
    $('#cin').addEventListener('input', update);
    $('#cutcancel').onclick = function () { newCutSession(); go('dashboard'); };
    /* Run 3: roll verification before cutting from an assignment. */
    if (C.needVerify) {
      mountScannerBox('cut-verifybox', onVerifyCode);
      $('#cut-verifyform').onsubmit = function (e) { e.preventDefault(); onVerifyCode($('#cut-verifycode').value); };
    }
    function onVerifyCode(code) {
      var v = rollByBarcode(code);
      var box = $('#cut-verifyresult');
      if (v && v.id === C.roll.id) {
        good();
        C.rollVerified = true;
        var now = new Date().toISOString();
        var rec0 = (FG().inventoryAssignments || []).filter(function (a) { return a.id === C.assignId; })[0];
        if (rec0) { rec0.rollVerifiedAt = now; rec0.rollVerifiedBy = DB.data.currentEmployee; DB.save(); }
        logAssignEvent('ROLL_VERIFIED', { user: DB.data.currentEmployee, workOrderId: C.woId,
          lineId: C.lineId, rollId: C.roll.id, assignmentId: C.assignId, detail: '✓ CORRECT ROLL' });
        box.innerHTML = '<div class="ok-panel"><div class="big-ok">&#10003; CORRECT ROLL</div></div>';
      } else {
        bad();
        C.rollVerified = false;
        var sup = isSupervisorRole(DB.data.currentEmployee);
        box.innerHTML = '<div class="err center">&#9888;&#65039; WRONG ROLL FOR THIS WORK ORDER<br>' +
          '<span style="font-size:1rem">Scanned "' + esc(code) + '", expected "' + esc(C.roll.id) + '".</span></div>' +
          (sup ? '<button class="btn" id="cut-verifyoverride" style="margin-top:8px">SUPERVISOR OVERRIDE — PROCEED ANYWAY</button>' : '');
        if (sup && $('#cut-verifyoverride')) $('#cut-verifyoverride').onclick = function () {
          C.rollVerified = true;
          logAssignEvent('ROLL_VERIFICATION_OVERRIDDEN', { user: DB.data.currentEmployee, workOrderId: C.woId,
            lineId: C.lineId, rollId: C.roll.id, assignmentId: C.assignId, detail: 'Supervisor overrode wrong-roll warning; scanned "' + code + '"' });
          box.innerHTML = '<div class="warn-panel"><div class="big-ok">OVERRIDE ACCEPTED</div></div>';
          good();
        };
      }
    }
    $('#savecut').onclick = function () {
      var ft = $('#cft').value.trim(), inch = $('#cin').value.trim();
      var cutIn = Math.round((parseFloat(ft || '0')) * 12 + parseFloat(inch || '0'));
      if (C.needVerify && !C.rollVerified) {
        bad();
        var ve = $('#cuterr'); ve.textContent = 'VERIFY THE ROLL BARCODE BEFORE CUTTING'; ve.hidden = false;
        return;
      }
      var woId = $('#wo').value;
      var wo = woId ? woById(woId) : null;
      var orderVal = wo ? wo.number : $('#order').value;
      var cutOpts = {
        rollId: roll.id, order: orderVal,
        cutIn: (ft === '' && inch === '') ? 0 : cutIn,
        employee: DB.data.currentEmployee, location: roll.expectedLocation,
        assignmentId: C.assignId || null, woId: wo ? wo.id : null
      };
      var screenBal = systemBalance(roll.id); /* for the conflict panel */
      if (dataMode() === 'local') {
        /* Synchronous local path — byte-for-byte Run 1–3 behavior. */
        var res = CutService.recordCut(cutOpts);
        if (!res.ok) { bad(); var e = $('#cuterr'); e.textContent = res.err; e.hidden = false; return; }
        /* Run 3: the cut consumes the reservation it was assigned for. */
        if (C.assignId) {
          consumeAssignment(C.assignId, { cutId: res.rec.id, actualCutIn: cutIn, by: DB.data.currentEmployee });
        }
        if (wo) {
          /* WORK ORDER -> ASSIGN INVENTORY -> CUT: the cut roll becomes the
             order's roll and the order moves to IN_PROGRESS. */
          wo.rollId = roll.id;
          if (wo.opStatus === 'OPEN') wo.opStatus = 'IN_PROGRESS';
          DB.save();
        }
        good();
        go('cut/saved', res.rec.id);
        return;
      }
      /* Shared mode: atomic backend RPC; the authoritative result is applied
         to the in-memory store by SharedFlow. */
      SharedFlow.recordCut(cutOpts).then(function (r) {
        good();
        go('cut/saved', r.rec.id);
      }).catch(function (err) {
        bad();
        cutSaveError(err, { roll: roll, screenBal: screenBal, cutIn: cutIn, cutOpts: cutOpts });
      });
    };
  }};
};

/* Run 4: shared-mode cut failure panels. Never silently pretends the
   backend accepted a cut it did not. */
function cutSaveError(err, ctx) {
  var box = $('#cuterr');
  var code = err && err.code;
  if (code === 'OFFLINE' || code === 'NETWORK') {
    /* Queue for explicit retry — the idempotency key makes retry safe. */
    if (typeof Sync !== 'undefined') {
      Sync.queue({ kind: 'cut', payload: ctx.cutOpts });
      Sync.set('OFFLINE');
    }
    box.hidden = false;
    box.innerHTML = '<b>OFFLINE &mdash; CUT NOT SYNCED</b><br>' +
      'The cut was <b>not</b> recorded. It is queued on this device.<br>' +
      '<button class="btn btn-primary" id="cut-retry" style="margin-top:10px">RETRY SYNC</button>';
    var rb = $('#cut-retry');
    if (rb) rb.onclick = function () { retryOutboxCuts(); };
    return;
  }
  if (code === 'ROLL_VERSION_CONFLICT' && err.data) {
    var cur = err.data.currentBalanceIn;
    box.hidden = false;
    box.innerHTML = '<b>ROLL UPDATED BY ANOTHER DEVICE</b><br>' +
      'Previous Screen Balance: <b class="num">' + fmtLen(ctx.screenBal) + '</b><br>' +
      'Current Balance: <b class="num">' + fmtLen(cur) + '</b><br>' +
      '<button class="btn btn-primary" id="cut-refresh" style="margin-top:10px">REFRESH AND CONTINUE</button>';
    var fb = $('#cut-refresh');
    if (fb) fb.onclick = function () {
      Repository.refresh().then(function () { render(); }).catch(function () { render(); });
    };
    return;
  }
  box.hidden = false;
  box.textContent = (err && err.message) || 'Cut failed.';
}
/* Explicit retry of queued cuts (shared mode). Each carries its idempotency
   key: a retry can resume, never duplicate. */
function retryOutboxCuts() {
  if (typeof Sync === 'undefined') return;
  var q = Sync.outbox().filter(function (i) { return i.kind === 'cut'; });
  if (!q.length) { toast('Nothing queued.'); return; }
  Sync.set('SYNCING');
  var chain = Promise.resolve(), done = 0, failed = 0;
  q.forEach(function (item) {
    chain = chain.then(function () {
      return SharedFlow.recordCut(item.payload).then(function () {
        Sync.dequeue(item.id); done++;
      }).catch(function (err) {
        failed++;
        if (err && err.code === 'ROLL_VERSION_CONFLICT') Sync.dequeue(item.id); /* re-enter with a fresh balance */
      });
    });
  });
  chain.then(function () {
    Sync.set(failed ? 'SYNC_ERROR' : 'SYNCED');
    toast(done + ' cut(s) synced' + (failed ? ', ' + failed + ' need attention' : ''));
    render();
  });
}

Screens['cut/saved'] = function (param) {
  var rec = FG().cuts.filter(function (c) { return c.id === param; })[0];
  if (!rec) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var html =
    '<div class="screen">' +
    '<div class="ok-panel"><h1>&#9986; CUT SAVED</h1>' +
    '<div class="kv"><span class="k">NEW EXPECTED BALANCE</span>' +
    '<span class="v num" style="font-size:2rem">' + fmtLen(rec.newIn) + '</span></div></div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(rec.rollId) + '</span></div>' +
      '<div class="kv"><span class="k">Order</span><span class="v mono">' + esc(rec.order || '—') + '</span></div>' +
      '<div class="kv"><span class="k">Previous Balance</span><span class="v num">' + fmtLen(rec.prevIn) + '</span></div>' +
      '<div class="kv"><span class="k">Cut</span><span class="v num">' + fmtLen(rec.inches) + '</span></div>' +
      '<div class="kv"><span class="k">New Balance</span><span class="v num">' + fmtLen(rec.newIn) + '</span></div>' +
      '<div class="kv"><span class="k">By</span><span class="v">' + esc(rec.by) + ' &middot; ' + fmtDT(rec.at) + '</span></div>' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" id="another">&#9986; CUT ANOTHER ROLL</button>' +
    '<button class="btn btn-huge" id="done">DONE &rarr; HOME</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#another').onclick = function () { newCutSession(); go('cut/scan'); };
    $('#done').onclick = function () { newCutSession(); go('dashboard'); };
  }};
};

Screens['count/standard/saved'] = function (param) {
  var rec = FG().counts.filter(function (c) { return c.id === (param || lastSavedId); })[0];
  if (!rec) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var panel = { MATCH: 'ok-panel', SHORT: 'warn-panel', OVER: 'over-panel',
                LOCATION_MISMATCH: 'warn-panel', NEEDS_REVIEW: 'over-panel' }[rec.status] || 'over-panel';
  var statusColor = { MATCH: 'var(--green)', SHORT: 'var(--red)', OVER: 'var(--yellow)',
                      LOCATION_MISMATCH: 'var(--red)', NEEDS_REVIEW: 'var(--yellow)' }[rec.status] || 'var(--yellow)';
  var html =
    '<div class="screen">' +
    '<div class="' + panel + '"><h1>CYCLE COUNT RESULT</h1>' +
    '<div class="result-status" style="color:' + statusColor + '">' + STATUS[rec.status].label + '</div></div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll</span><span class="v mono result-num">' + esc(rec.rollId) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono result-num">' + esc(rec.scannedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">System Balance</span><span class="v num result-num">' + fmtLen(rec.expectedIn) + '</span></div>' +
      '<div class="kv"><span class="k">Physical Balance</span><span class="v num result-num">' + fmtLen(rec.physicalIn) + '</span></div>' +
      '<div class="kv"><span class="k">Difference</span><span class="v ' + diffCls(rec.diffIn) + ' num result-num">' + fmtDiff(rec.diffIn) + '</span></div>' +
      '<div class="kv"><span class="k">By</span><span class="v">' + esc(rec.employee) + ' &middot; ' + fmtDT(rec.at) + '</span></div>' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" id="another">&#9654; COUNT ANOTHER ROLL</button>' +
    '<button class="btn btn-huge" id="done">DONE &rarr; HOME</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#another').onclick = function () { newSession(); go('count/standard'); };
    $('#done').onclick = function () { go('dashboard'); };
  }};
};

/* ---------------- ROLL HISTORY ------------------------------------------------- */

/* ---- prototype lines 1188-1326 ---- */
Screens['roll'] = function (param) {
  var roll = rollById(param);
  if (!roll) {
    var disc0 = (typeof findDiscovered === 'function') ? findDiscovered(param) : null;
    if (disc0) return rollDiscoveredScreen(param);
    setTimeout(function () { go('rolls/search'); }, 0); return { html: '' };
  }
  var sys = systemBalance(roll.id);
  var docs = docsForRoll(roll.id);
  var html =
    '<div class="screen">' +
    '<div class="step-head">ROLL HISTORY</div>' +
    '<h1 class="mono">' + esc(roll.id) + '</h1>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Manufacturer</span><span class="v">' + esc(roll.manufacturer) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + fmtWidth(roll.widthIn) + '</span></div>' +
      '<div class="kv"><span class="k">Beginning Length</span><span class="v num">' + fmtLen(roll.beginningIn) + '</span></div>' +
      '<div class="kv"><span class="k">Current Balance</span><span class="v num">' + fmtLen(sys) + '</span></div>' +
      '<div class="kv"><span class="k">Current Location</span><span class="v mono">' + esc(roll.expectedLocation) + '</span></div>' +
      (roll.measuredIn != null
        ? '<div class="kv"><span class="k">Measured Balance <span class="stchip st-green">MB ✓</span></span><span class="v num">' + fmtLen(roll.measuredIn) + '</span></div>' +
          '<div class="kv"><span class="k">Last Measured</span><span class="v">' + fmtDT(roll.measuredAt) + ' &middot; ' + esc(roll.measuredBy || '') + '</span></div>'
        : '<div class="kv"><span class="k">Measured Balance</span><span class="v">Not measured yet</span></div>') +
    '</div>' +
    '<button class="btn btn-primary btn-huge" id="scanhist">&#128247; SCAN HISTORY CARD</button>' +
    '<h2>Activity History</h2>' +
    '<div class="ledger">' + ledgerHtml(roll) + '</div>' +
    '<h2>Documents</h2>' +
    '<div class="label" style="margin-bottom:8px">ORIGINAL HISTORY CARDS</div>' +
    (docs.length ? docsHtml(docs) : '<div class="hint">No history cards captured yet.</div>') +
    '<button class="btn btn-huge" id="cutthis">&#9986; CUT THIS ROLL</button>' +
    '<button class="btn btn-primary btn-huge" id="countthis">&#9654; COUNT THIS ROLL</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#scanhist').onclick = function () {
      newDocCapture(roll.id, { location: roll.expectedLocation, returnTo: { name: 'roll', param: roll.id } });
      go('roll/doc');
    };
    $('#cutthis').onclick = function () { newCutSession(); C.roll = roll; go('cut/entry'); };
    $('#countthis').onclick = function () { newSession(); S.roll = roll; go('count/standard/loc'); };
    wireDocViews();
    Array.prototype.forEach.call(document.querySelectorAll('[data-wo]'), function (b) {
      b.onclick = function () { go('work-order', b.getAttribute('data-wo')); };
    });
  }};
};

/* One-line summary of confirmed extracted fields for the timeline. */
function importSummary(f) {
  var bits = [];
  if (f.job) bits.push('Job ' + esc(f.job));
  if (f.order) bits.push('Order ' + esc(f.order));
  if (f.cut) bits.push('Cut ' + fmtLen(f.cut.totalIn));
  if (f.balance) bits.push('Balance ' + fmtLen(f.balance.totalIn));
  if (f.measured) bits.push('MB ' + fmtLen(f.measured.totalIn));
  if (f.date) bits.push(esc(f.date));
  if (f.size) bits.push('Size ' + esc(f.size));
  if (f.notes) bits.push('“' + esc(f.notes) + '”');
  return bits.length ? bits.join(' &middot; ') : 'No values entered.';
}

function ledgerHtml(roll) {
  var ev = [];
  FG().cuts.forEach(function (c) {
    if (c.rollId === roll.id) ev.push({ kind: 'cut', at: c.at, inches: c.inches, by: c.by, order: c.order, newIn: c.newIn });
  });
  /* WORK ORDER ACTIVITY: orders with this roll assigned. */
  (FG().workOrders || []).forEach(function (w) {
    if (w.rollId === roll.id) ev.push({ kind: 'wo', at: w.createdAt, wo: w });
  });
  /* Run 3: inventory assignments are append-only roll history — ASSIGNED TO
     WORK ORDER events with property, reserved quantity, employee, date/time. */
  (FG().inventoryAssignments || []).forEach(function (a) {
    if (a.rollId === roll.id) ev.push({ kind: 'assign', at: a.at, a: a });
  });
  FG().counts.forEach(function (c) {
    if (c.rollId === roll.id) ev.push({ kind: 'count', at: c.at, rec: c });
  });
  /* Free-run discovery counts for known rolls belong in the roll's history too:
     they are real physical measurements, tagged as free-run. */
  (FG().freeCounts || []).forEach(function (c) {
    if (c.rollId === roll.id) ev.push({ kind: 'freecount', at: c.at, rec: c });
  });
  /* History card captures and their confirmed smart-extractions are timeline
     events too. They never touch balances — they document the paper trail. */
  (FG().documents || []).forEach(function (d) {
    if (d.rollId === roll.id) {
      ev.push({ kind: 'doc', at: d.at, doc: d });
      (d.imports || []).forEach(function (imp) {
        ev.push({ kind: 'import', at: imp.confirmedAt, doc: d, imp: imp });
      });
    }
  });
  ev.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  var out = '<div class="ledger-row"><span class="dot" style="background:var(--muted)"></span>' +
    '<div class="what"><b>Beginning Balance</b></div>' +
    '<div class="bal num">' + fmtLen(roll.beginningIn) + '</div></div>';
  var bal = roll.beginningIn;
  ev.forEach(function (e) {
    if (e.kind === 'cut') {
      /* Prefer the balance stored on the cut record (exact at cut time, and it
         already accounts for any test-balance adjustment); fall back to the
         running calculation only for legacy records that lack it. */
      var newBal = (e.newIn != null) ? e.newIn : (bal - e.inches);
      bal = newBal;
      var orderTag = e.order ? ' <span class="mono">Order ' + esc(e.order) + '</span>' : '';
      out += '<div class="ledger-row"><span class="dot" style="background:var(--blue)"></span>' +
        '<div class="what"><b>Cut</b> <span class="num">' + fmtLen(e.inches) + '</span>' + orderTag +
        '<div class="sub">' + fmtDT(e.at) + ' &middot; ' + esc(e.by) + ' &middot; <span class="srcchip">FLOORGUARD</span></div></div>' +
        '<div class="bal"><div class="sub">New Balance</div><span class="num">' + fmtLen(newBal) + '</span></div></div>';
    } else if (e.kind === 'wo') {
      var wact = e.wo;
      out += '<div class="ledger-row"><span class="dot" style="background:#a78bfa"></span>' +
        '<div class="what"><b>Work Order Activity</b> <span class="mono">' + esc(wact.number) + '</span> ' + woStatusChip(wact) +
        '<div class="sub">' + esc(wact.property) + ' &middot; ' + fmtDT(wact.createdAt) + ' &middot; <span class="srcchip">FLOORGUARD</span></div></div>' +
        '<div class="bal"><button class="btn btn-xs" data-wo="' + esc(wact.id) + '">OPEN ORDER</button></div></div>';
    } else if (e.kind === 'count') {
      var r = e.rec;
      var phys = (r.physicalIn == null) ? '—' : fmtLen(r.physicalIn);
      var ddiff = (r.diffIn == null) ? '—' : fmtDiff(r.diffIn);
      var dcls = (r.diffIn == null) ? '' : diffCls(r.diffIn);
      var mb = isMeasuredCount(r) ? ' <span class="stchip st-green">MB ✓</span>' : '';
      out += '<div class="ledger-row"><span class="dot" style="background:' +
        (r.status === 'MATCH' ? 'var(--green)' : r.status === 'NEEDS_REVIEW' ? 'var(--yellow)' : 'var(--red)') + '"></span>' +
        '<div class="what"><b>Physical Cycle Count</b> <span class="num">' + phys + '</span> ' + statusChip(r.status) + mb +
        '<div class="sub">' + fmtDT(r.at) + ' &middot; ' + esc(r.employee) + ' &middot; loc <span class="mono">' + esc(r.scannedLocation) + '</span> &middot; <span class="srcchip">FLOORGUARD</span></div></div>' +
        '<div class="bal"><div class="sub">Difference</div><span class="' + dcls + ' num">' + ddiff + '</span></div></div>';
    } else if (e.kind === 'freecount') {
      /* Free-run discovery count: a real physical measurement collected without
         a system comparison. Shown with its COLLECTED status and MB marker. */
      var fc = e.rec;
      var fdiff = (fc.expectedIn == null) ? '—' : fmtDiff(fc.physicalIn - fc.expectedIn);
      out += '<div class="ledger-row"><span class="dot" style="background:var(--blue)"></span>' +
        '<div class="what"><b>Free-Run Count</b> <span class="num">' + fmtLen(fc.physicalIn) + '</span> ' +
        statusChip('COLLECTED') + ' <span class="stchip st-green">MB ✓</span>' +
        '<div class="sub">' + fmtDT(fc.at) + ' &middot; ' + esc(fc.employee) + ' &middot; loc <span class="mono">' + esc(fc.location) + '</span> &middot; <span class="srcchip">FLOORGUARD</span></div></div>' +
        '<div class="bal"><div class="sub">vs Expected</div><span class="num">' + fdiff + '</span></div></div>';
    } else if (e.kind === 'doc') {
      /* HISTORY CARD CAPTURED: the photo is the record. VIEW DOCUMENT opens
         the full-size original; the image is never altered after capture. */
      var dc = e.doc;
      out += '<div class="ledger-row"><span class="dot" style="background:var(--yellow)"></span>' +
        '<div class="what"><b>History Card Captured</b> <span class="srcchip">PAPER CARD</span>' +
        '<div class="sub">' + fmtDT(dc.at) + ' &middot; ' + esc(dc.employee) +
        (dc.location ? ' &middot; loc <span class="mono">' + esc(dc.location) + '</span>' : '') + '</div></div>' +
        '<div class="bal"><button class="btn btn-xs" data-docview="' + esc(dc.id) + '">VIEW DOCUMENT</button></div></div>';
    } else if (e.kind === 'import') {
      /* PAPER CARD IMPORT: human-confirmed data extracted from a history card.
         Displayed as history only — it never changes expected balances. */
      var im = e.imp;
      out += '<div class="ledger-row"><span class="dot" style="background:var(--yellow)"></span>' +
        '<div class="what"><b>Paper Card Import</b> <span class="srcchip src-import">PAPER CARD IMPORT</span>' +
        '<div class="sub">' + fmtDT(im.confirmedAt) + ' &middot; ' + esc(im.confirmedBy) + '</div>' +
        '<div class="sub">' + importSummary(im.fields) + '</div></div>' +
        '<div class="bal"><button class="btn btn-xs" data-docview="' + esc(im.docId || e.doc.id) + '">VIEW DOCUMENT</button></div></div>';
    } else if (e.kind === 'assign') {
      /* ASSIGNED TO WORK ORDER: the append-only assignment record. The roll's
         trusted balance is unchanged — only cuts change it. */
      var as = e.a, awo = woById(as.workOrderId);
      out += '<div class="ledger-row"><span class="dot" style="background:#a78bfa"></span>' +
        '<div class="what"><b>Assigned to Work Order</b> <span class="mono">' + esc(awo ? awo.number : as.workOrderId) + '</span> ' +
        aiAssignStatusChip(as.status) +
        '<div class="sub">' + esc(awo ? awo.property : '') + ' &middot; reserved <span class="num">' + fmtLen(as.reservedIn) + '</span>' +
        ' &middot; ' + fmtDT(as.at) + ' &middot; ' + esc(as.employee) + ' &middot; <span class="srcchip">FLOORGUARD</span></div></div>' +
        '<div class="bal"><div class="sub">Required</div><span class="num">' + fmtLen(as.requiredIn) + '</span></div></div>';
    }
  });
  return out;
}

/* ---------------- RECENT COUNTS + COUNT DETAIL (audit) -------------------------- */

/* ---- prototype lines 1327-1357 ---- */
Screens['history'] = function () {
  var list = FG().counts.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  var html =
    '<div class="screen">' +
    '<div class="step-head">AUDIT LOG &mdash; APPEND ONLY</div>' +
    '<h1>Recent counts</h1>' +
    (list.length ? list.map(countRow).join('') : '<p class="hint center">No counts yet.</p>') +
    '</div>';
  return { html: html, mount: function () { wireCountRows(); } };
};

function countRow(c) {
  var date = c.date || new Date(c.at).toLocaleDateString();
  var time = c.time || fmtTime(c.at);
  var mb = isMeasuredCount(c) ? ' <span class="stchip st-green">MB ✓</span>' : '';
  var balLine = (c.physicalIn == null)
    ? '<div class="sub">mismatch flagged — not measured</div>'
    : '<div class="sub num">Sys <b>' + fmtLen(c.expectedIn) + '</b> &middot; Phys <b>' + fmtLen(c.physicalIn) + '</b>' +
      ' &middot; Diff <b class="' + diffCls(c.diffIn) + '">' + fmtDiff(c.diffIn) + '</b></div>';
  return '<button class="rowbtn" data-count="' + esc(c.id) + '">' +
    '<div class="rhead"><b class="mono">' + esc(c.rollId) + '</b>' + statusChip(c.status) + mb + '</div>' +
    '<div class="sub"><b>' + esc(time) + '</b> &middot; loc <b class="mono">' + esc(c.scannedLocation) + '</b></div>' +
    balLine +
    '<div class="sub">' + esc(date) + ' &middot; ' + esc(c.employee) + '</div></button>';
}
function wireCountRows() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-count]'), function (b) {
    b.onclick = function () { go('count/detail', b.getAttribute('data-count')); };
  });
}

/* ---- prototype lines 1358-1401 ---- */
Screens['count/detail'] = function (param) {
  var c = FG().counts.filter(function (x) { return x.id === param; })[0];
  if (!c) { setTimeout(function () { go('history'); }, 0); return { html: '' }; }
  var roll = rollById(c.rollId);
  var barcode = c.barcode || (roll ? roll.barcode : c.rollId);
  var date = c.date || new Date(c.at).toLocaleDateString();
  var time = c.time || fmtTime(c.at);
  var html =
    '<div class="screen">' +
    '<div class="step-head">COUNT DETAIL</div>' +
    '<h1 class="mono">' + esc(c.rollId) + '</h1>' +
    '<div style="margin-bottom:8px">' + statusChip(c.status) + '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll Number</span><span class="v mono">' + esc(c.rollId) + '</span></div>' +
      '<div class="kv"><span class="k">Roll Barcode</span><span class="v mono">' + esc(barcode) + '</span></div>' +
      '<div class="kv"><span class="k">Product / Style</span><span class="v">' + esc(c.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(c.color) + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + fmtWidth(c.widthIn) + '</span></div>' +
      '<div class="kv"><span class="k">Location Barcode</span><span class="v mono">' + esc(c.scannedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">Expected Location</span><span class="v mono">' + esc(c.expectedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">Scanned Location</span><span class="v mono">' + esc(c.scannedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">Expected Balance</span><span class="v num">' + fmtLen(c.expectedIn) + '</span></div>' +
      '<div class="kv"><span class="k">Physical Balance' + (isMeasuredCount(c) ? ' <span class="stchip st-green">MB ✓</span>' : '') + '</span><span class="v num">' +
        (c.physicalIn == null ? '— (not measured)' : fmtLen(c.physicalIn)) + '</span></div>' +
      '<div class="kv"><span class="k">Difference</span><span class="v ' + (c.diffIn == null ? '' : diffCls(c.diffIn)) + ' num">' +
        (c.diffIn == null ? '—' : fmtDiff(c.diffIn)) + '</span></div>' +
      '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(c.employee) + '</span></div>' +
      '<div class="kv"><span class="k">Date</span><span class="v">' + esc(date) + '</span></div>' +
      '<div class="kv"><span class="k">Time</span><span class="v">' + esc(time) + '</span></div>' +
      '<div class="kv"><span class="k">Count Status</span><span class="v">' + statusChip(c.status) + '</span></div>' +
    '</div>' +
    '<button class="btn" id="goroll">VIEW ROLL HISTORY</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#goroll').onclick = function () { go('roll', c.rollId); };
  }};
};

/* ---------------- SET TEST SYSTEM BALANCE (supervisor / pilot only) -------------
   TEMPORARY PILOT FUNCTIONALITY: the prototype is not connected to the Real
   Floors database yet, so a supervisor can type in the balance the Real Floors
   system currently shows for a roll. Stored as roll.testBalanceIn (integer
   inches); systemBalance() returns it when set, and it appears automatically
   when a worker scans the roll. To integrate the Real Floors API/database

/* ---- prototype lines 1476-1485 ---- */
var F = null;
function newFreeRun() {
  F = { id: 'FR' + Date.now().toString(36).toUpperCase(),
        startedAt: new Date().toISOString(),
        startedBy: DB.data.currentEmployee,
        activeLoc: null, scan: null, lastMsg: null };
}
/* Same normalization as rollByBarcode (manufacturer tags often prefix the roll
   number with "01"), so a scanned tag resolves identically for discovered
   rolls as it does for known ones. */

/* ---- prototype lines 1486-1586 ---- */
function normalizeBarcode(code) {
  var c = String(code || '').trim().toUpperCase();
  var s = c.replace(/^01/, '');
  return s || c;
}
function findDiscovered(id) {
  var ds = FG().discovered || [];
  for (var i = 0; i < ds.length; i++) if (ds[i].id === id) return ds[i];
  return null;
}
function freeCountsFor(sessionId) {
  return (FG().freeCounts || []).filter(function (c) { return c.sessionId === sessionId; });
}
function findFreeSession(id) {
  var ss = FG().freeSessions || [];
  for (var i = 0; i < ss.length; i++) if (ss[i].id === id) return ss[i];
  return null;
}

/* ================= PILOT SESSION & MANAGER REPORT =================
   Everything in this block is read-only reporting over the existing
   Free Run collections (freeSessions, freeCounts, discovered, documents).
   No existing counting/cut/scanner behavior is changed by these helpers. */

/* Human duration: 937000 -> "15m 37s", 5000 -> "5s". */
function fmtDur(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '—';
  var s = Math.round(ms / 1000);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

/* Per-count manager status for Free Run. Priority order:
   NEEDS REVIEW > LOCATION ISSUE > NEWLY DISCOVERED > MATCH/SHORT/OVER.
   A count is a discrepancy when its status is SHORT, OVER, LOCATION ISSUE,
   or NEEDS REVIEW. */
function freeCountStatus(c) {
  if (c.needsReview) return 'NEEDS REVIEW';
  if (c.locationIssue) return 'LOCATION ISSUE';
  if (c.discovered) return 'NEWLY DISCOVERED';
  if (c.expectedIn == null) return 'COLLECTED';
  var d = c.physicalIn - c.expectedIn;
  return d === 0 ? 'MATCH' : (d < 0 ? 'SHORT' : 'OVER');
}
function freeCountDiff(c) {
  return (c.expectedIn == null || c.physicalIn == null) ? null : c.physicalIn - c.expectedIn;
}
function isDiscrepancy(c) {
  var st = freeCountStatus(c);
  return st === 'SHORT' || st === 'OVER' || st === 'LOCATION ISSUE' || st === 'NEEDS REVIEW';
}

/* One denormalized row per counted roll in a session, for the report table. */
function reportRows(sessId) {
  return freeCountsFor(sessId).map(function (c) {
    var roll = c.discovered ? null : rollByBarcode(c.rollId);
    var sessDocs = docsForRoll(c.rollId).filter(function (d) { return d.sessionId === sessId; });
    return {
      loc: c.location, rollId: c.rollId, raw: c.raw || c.rollId,
      style: roll ? roll.style : '—', color: roll ? roll.color : '—',
      expectedIn: c.expectedIn, physicalIn: c.physicalIn,
      diffIn: freeCountDiff(c), mb: !!c.measured,
      docs: sessDocs.length, docIds: sessDocs.map(function (d) { return d.id; }),
      status: freeCountStatus(c), employee: c.employee, time: c.time, at: c.at,
      discovered: !!c.discovered, note: c.note || '', needsReview: !!c.needsReview,
      locationIssue: !!c.locationIssue
    };
  }).sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
}

/* Pilot metrics for a session: §11 of the pilot spec. */
function sessionMetrics(sessId) {
  var counts = freeCountsFor(sessId).slice()
    .sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  var locs = {}, rolls = {}, review = 0, disc = 0;
  counts.forEach(function (c) {
    locs[c.location] = 1; rolls[c.rollId] = 1;
    if (isDiscrepancy(c)) disc++;
    if (c.needsReview) review++;
  });
  var avgMs = null;
  if (counts.length > 1) {
    var gaps = 0;
    for (var i = 1; i < counts.length; i++)
      gaps += new Date(counts[i].at) - new Date(counts[i - 1].at);
    avgMs = gaps / (counts.length - 1);
  }
  var sess = findFreeSession(sessId);
  var totalMs = (sess && sess.endedAt)
    ? new Date(sess.endedAt) - new Date(sess.startedAt) : null;
  var cards = (FG().documents || []).filter(function (d) { return d.sessionId === sessId; }).length;
  return {
    rolls: counts.length, locations: Object.keys(locs).length,
    uniqueRolls: Object.keys(rolls).length, avgMs: avgMs, totalMs: totalMs,
    discrepancies: disc, needsReview: review, historyCards: cards
  };
}

/* Live session counter strip (§3): small, non-blocking, sits under the step head. */

/* ---- prototype lines 1587-1604 ---- */
function freeSessionBar() {
  if (!F || !F.id) return '';
  var counts = freeCountsFor(F.id);
  var locs = {}, measured = 0, review = 0;
  counts.forEach(function (c) {
    locs[c.location] = 1;
    if (c.measured) measured++;
    if (isDiscrepancy(c)) review++;
  });
  return '<div class="sessbar"><span class="sessbar-live">&#128994;</span> ' +
    '<b>SESSION IN PROGRESS</b> <span class="mono sessbar-id">' + esc(F.id) + '</span>' +
    '<div class="sessbar-nums">Locations <b>' + Object.keys(locs).length + '</b>' +
    ' &middot; Rolls Counted <b>' + counts.length + '</b>' +
    ' &middot; Measured <b>' + measured + '</b>' +
    ' &middot; Needs Review <b>' + review + '</b></div></div>';
}

/* --- STEP 1: scan ANY location. No DB requirement. --- */

/* ---- prototype lines 1605-1641 ---- */
Screens['count/free/loc'] = function () {
  if (!F) newFreeRun();
  var html =
    '<div class="screen">' +
    '<div class="step-head">FREE RUN &mdash; DISCOVERY MODE &mdash; STEP 1</div>' +
    '<h1>Scan location</h1>' +
    '<p class="hint">Scan <b>any</b> warehouse location barcode &mdash; it does <b>not</b> need to be preloaded. FloorGuard uses it as the active count location for every roll you scan next.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE LOCATION CODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. 210C">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">USE LOCATION</button></form>' +
    '<div id="result"></div>' +
    '<button class="btn btn-ghost" id="flcancel">CANCEL</button>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    $('#flcancel').onclick = function () { F = null; go('dashboard'); };
  }};
  function onCode(code) {
    var loc = normLoc(code);
    if (!loc) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; EMPTY SCAN &mdash; try again.</div>';
      return;
    }
    good();
    F.activeLoc = loc;
    F.lastMsg = null;
    go('count/free/scan');
  }
};

/* Custom confirm modal. Returns a Promise<boolean>. Tapping outside the
   dialog counts as cancel. */

/* ---- prototype lines 1663-1953 ---- */
function freeBanner() {
  var m = F && F.lastMsg;
  if (!m) return '';
  return '<div class="card" style="border:2px solid var(--blue);text-align:center">' +
    '<div style="font-size:1.4rem;font-weight:900;color:var(--blue)">' + esc(m) + '</div></div>';
}

Screens['count/free/scan'] = function () {
  if (!F || !F.activeLoc) { setTimeout(function () { go('count/free/loc'); }, 0); return { html: '' }; }
  var chips = FG().rolls.map(function (r) {
    return '<button class="demochip" data-code="' + esc(r.barcode) + '">' + esc(r.barcode) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">FREE RUN &mdash; DISCOVERY MODE</div>' +
    freeSessionBar() +
    '<div class="card" style="text-align:center">' +
      '<div class="label">ACTIVE LOCATION</div>' +
      '<div class="mono" style="font-size:2.4rem;font-weight:900">' + esc(F.activeLoc) + '</div>' +
    '</div>' +
    freeBanner() +
    '<h1>Scan roll</h1>' +
    '<p class="hint">Scan <b>any</b> roll &mdash; known or never-before-seen. New barcodes are discovered automatically.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE BARCODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. 01QH5CPHN">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '<div class="btn-row">' +
      '<button class="btn" id="fchangeloc" style="flex:1">&#8646; CHANGE LOCATION</button>' +
      '<button class="btn btn-primary" id="fend" style="flex:1">END COUNT SESSION</button>' +
    '</div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
    $('#fchangeloc').onclick = function () { go('count/free/loc'); };
    /* §4: confirm before finishing — CANCEL / FINISH. Custom modal, not the
       native confirm(): native dialogs can't show a FINISH button and are
       auto-dismissed by headless/automated browsers. */
    $('#fend').onclick = function () {
      var n = freeCountsFor(F.id).length;
      showConfirm({
        title: 'FINISH THIS CYCLE COUNT?',
        body: n + ' roll' + (n === 1 ? '' : 's') + ' collected in session ' + F.id +
              '. CANCEL keeps counting; FINISH ends the session.',
        okLabel: 'FINISH', cancelLabel: 'CANCEL'
      }).then(function (ok) { if (ok) endFreeSession(); });
    };
  }};

  function onCode(code) {
    var raw = String(code || '').trim();
    if (!raw) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; EMPTY SCAN &mdash; try again.</div>';
      return;
    }
    var id = normalizeBarcode(code);
    var roll = rollByBarcode(code);
    var expectedIn = null;
    if (roll) {
      /* Known roll: FloorGuard MAY show the expected balance, but it is never
         required and never blocks the count. */
      expectedIn = systemBalance(roll.id);
    } else {
      /* Never seen before: create the discovered-roll record right now so the
         physical scan is never an error. */
      var d = findDiscovered(id);
      if (!d) {
        d = { id: id, raw: raw.toUpperCase(),
              firstSeenAt: new Date().toISOString(), firstSeenBy: DB.data.currentEmployee,
              lastLocation: F.activeLoc,
              lastMeasuredIn: null, lastMeasuredAt: null, lastMeasuredBy: null, count: 0 };
        FG().discovered.push(d);
        DB.save();
      }
    }
    good();
    F.scan = { rollId: id, raw: raw.toUpperCase(), known: !!roll, expectedIn: expectedIn };
    go('count/free/balance');
  }
};

/* --- STEP 3: enter the physical balance, save, loop --- */
Screens['count/free/balance'] = function () {
  if (!F || !F.activeLoc || !F.scan) { setTimeout(function () { go('count/free/scan'); }, 0); return { html: '' }; }
  var s = F.scan;
  var roll = s.known ? rollByBarcode(s.rollId) : null;
  var rows;
  if (roll) {
    rows =
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + fmtWidth(roll.widthIn) + '</span></div>' +
      '<div class="kv"><span class="k">Manufacturer</span><span class="v">' + esc(roll.manufacturer) + '</span></div>';
  } else {
    rows =
      '<div class="kv"><span class="k">Style</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>' +
      '<div class="kv"><span class="k">Manufacturer</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>';
  }
  var expRow = s.expectedIn != null
    ? '<span class="v num" style="font-size:2rem">' + fmtLen(s.expectedIn) + '</span>'
    : '<span class="v" style="color:var(--muted)">Not available</span>';
  var html =
    '<div class="screen">' +
    '<div class="step-head">FREE RUN &mdash; DISCOVERY MODE &mdash; ' + esc(F.activeLoc) + '</div>' +
    freeSessionBar() +
    '<div class="card" style="text-align:center">' +
      '<div class="label">ROLL SCANNED</div>' +
      '<div class="mono" style="font-size:2.2rem;font-weight:900">' + esc(s.rollId) + '</div>' +
      (s.raw !== s.rollId ? '<div class="sub mono">tag read: ' + esc(s.raw) + '</div>' : '') +
      (s.known ? '' : '<div><span class="stchip st-blue">NEW / DISCOVERED</span></div>') +
    '</div>' +
    '<div class="card">' +
      rows +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(F.activeLoc) + '</span></div>' +
      '<div class="kv"><span class="k">EXPECTED BALANCE</span>' + expRow + '</div>' +
    '</div>' +
    '<div class="label">MEASURED BALANCE</div>' +
    '<button class="btn" id="fdochist" style="margin-bottom:14px">&#128247; SCAN HISTORY CARD <span class="sub">(optional)</span></button>' +
    '<button class="btn" id="fflag">&#9873; FLAG FOR REVIEW <span class="sub">(optional)</span></button>' +
    '<div class="field" id="fflagwrap" hidden style="margin-top:8px"><label class="label" for="fnote">REVIEW NOTE</label>' +
    '<input class="input" id="fnote" autocomplete="off" placeholder="e.g. label damaged, move pending"></div>' +
    '<div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">FEET</label>' +
      '<input class="input num" id="fft" inputmode="numeric" autocomplete="off" placeholder="0" style="font-size:2.2rem;min-height:84px;text-align:center"></div>' +
      '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
      '<input class="input num" id="fin" inputmode="decimal" autocomplete="off" placeholder="0" style="font-size:2.2rem;min-height:84px;text-align:center"></div>' +
    '</div>' +
    '<div class="card" style="text-align:center"><div class="label">MEASURED BALANCE</div>' +
      '<div class="num" id="fmeas" style="font-size:2.4rem;font-weight:900">0\' 0"</div></div>' +
    '<div class="err" id="ferr" hidden></div>' +
    '<button class="btn btn-primary btn-huge" id="fsavenext">&#10003; SAVE &amp; NEXT</button>' +
    '<button class="btn" id="fback">&larr; BACK TO SCANNER</button>' +
    '</div>';
  return { html: html, mount: function () {
    var upd = function () {
      var ft = parseFloat($('#fft').value) || 0, inch = parseFloat($('#fin').value) || 0;
      $('#fmeas').textContent = fmtLen(Math.round(ft * 12 + inch));
    };
    $('#fft').oninput = upd; $('#fin').oninput = upd;
    $('#fback').onclick = function () { F.scan = null; go('count/free/scan'); };
    /* FLAG FOR REVIEW: optional toggle. When on, the saved count carries
       needsReview=true plus the note, and shows up in NEEDS REVIEW. */
    $('#fflag').onclick = function () {
      s.flagReview = !s.flagReview;
      var on = s.flagReview;
      $('#fflag').className = 'btn' + (on ? ' btn-warn' : '');
      $('#fflag').innerHTML = on ? '&#9873; FLAGGED FOR REVIEW &mdash; TAP TO UNFLAG' : '&#9873; FLAG FOR REVIEW <span class="sub">(optional)</span>';
      $('#fflagwrap').hidden = !on;
      if (on) setTimeout(function () { $('#fnote').focus(); }, 50);
      else s.flagNote = '';
    };
    $('#fdochist').onclick = function () {
      /* Optional: capture the paper history card, then come back here to
         enter the measured balance. Never forced, normally once per roll. */
      newDocCapture(s.rollId, { location: F.activeLoc, returnTo: { name: 'count/free/balance' } });
      go('roll/doc');
    };
    $('#fsavenext').onclick = function () {
      var ft = parseFloat($('#fft').value), inch = parseFloat($('#fin').value);
      var err = '';
      if ($('#fft').value.trim() === '' && $('#fin').value.trim() === '') err = 'Enter feet and/or inches.';
      else if (isNaN(ft) || isNaN(inch) || ft < 0 || inch < 0) err = 'Numbers must be zero or more.';
      if (err) { bad(); var e = $('#ferr'); e.textContent = err; e.hidden = false; return; }
      s.flagNote = s.flagReview ? ($('#fnote').value || '') : '';
      saveFreeCount(ft, inch);
    };
  }};
};

function saveFreeCount(ft, inch) {
  var s = F.scan;
  var physicalIn = Math.round(ft * 12 + inch);
  /* Run 4 shared mode: atomic backend write (+ensureRoll for discoveries),
     then refresh. */
  if (dataMode() === 'shared' && typeof SharedRepo !== 'undefined') {
    var sRoll = s.known ? rollByBarcode(s.rollId) : findDiscovered(s.rollId);
    sharedRecordCount({
      rollId: s.rollId, scannedLocation: F.activeLoc,
      expectedIn: (s.expectedIn != null ? s.expectedIn : 0),
      physicalIn: physicalIn, status: 'COLLECTED', employee: DB.data.currentEmployee,
      note: (s.flagNote || '').trim() || null, discovered: !s.known, roll: sRoll
    }).then(function () {
      good();
      F.lastMsg = '✓ COLLECTED — ' + s.rollId + ' ' + fmtLen(physicalIn);
      F.scan = null;
      go('count/free/scan'); /* straight back to the scanner — never home */
    }).catch(function (err) {
      bad();
      countOffline(err, { kind: 'count', payload: {
        rollId: s.rollId, scannedLocation: F.activeLoc,
        expectedIn: (s.expectedIn != null ? s.expectedIn : 0),
        physicalIn: physicalIn, status: 'COLLECTED', employee: DB.data.currentEmployee,
        note: (s.flagNote || '').trim() || null, discovered: !s.known,
        warehouseId: Repository.config.warehouseId
      }});
    });
    return;
  }
  var now = new Date();
  var rec = {
    id: 'FC' + now.getTime().toString(36).toUpperCase(),
    sessionId: F.id,
    rollId: s.rollId, barcode: s.rollId, raw: s.raw,
    discovered: !s.known,
    location: F.activeLoc,
    measuredFt: ft, measuredInch: inch, physicalIn: physicalIn,
    expectedIn: s.expectedIn, /* null for discovered rolls: no system balance */
    status: 'COLLECTED',      /* discovery collects; it never judges */
    measured: true,          /* MB: the worker physically measured this roll */
    employee: DB.data.currentEmployee,
    at: now.toISOString(),
    date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
    /* Pilot session fields (§2): optional review flag + note; locationIssue is
       auto-detected when a known roll is counted away from its expected
       location. Older records simply lack these fields (treated as false). */
    needsReview: !!(s.flagReview), note: (s.flagNote || '').trim() || null,
    locationIssue: (s.known && (function () {
      var r = rollByBarcode(s.rollId);
      return r && normLoc(F.activeLoc) !== normLoc(r.expectedLocation);
    })())
  };
  FG().freeCounts.push(rec);
  if (s.known) {
    /* A real physical measurement: stamp the roll's measured fields so the
       supervisor can see the last physical reading in roll history. */
    var roll = rollByBarcode(s.rollId);
    if (roll) { roll.measuredIn = physicalIn; roll.measuredAt = rec.at; roll.measuredBy = rec.employee; }
  } else {
    var d = findDiscovered(s.rollId);
    if (d) {
      d.lastLocation = F.activeLoc;
      d.lastMeasuredIn = physicalIn;
      d.lastMeasuredAt = rec.at;
      d.lastMeasuredBy = rec.employee;
      d.count++;
    }
  }
  DB.save();
  good();
  F.lastMsg = '✓ COLLECTED — ' + s.rollId + ' ' + fmtLen(physicalIn);
  F.scan = null;
  go('count/free/scan'); /* straight back to the scanner — never home */
}

function endFreeSession() {
  if (!F) { go('dashboard'); return; }
  var now = new Date();
  FG().freeSessions.push({
    id: F.id, startedAt: F.startedAt, startedBy: F.startedBy, endedAt: now.toISOString()
  });
  DB.save();
  F.endedAt = now.toISOString();
  go('count/free/summary');
}

/* --- SESSION SUMMARY: supervisor review of the whole collected count --- */
Screens['count/free/summary'] = function () {
  if (!F || !F.id) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var sessId = F.id;
  return { html: sessionSummaryHtml(sessId, 'DONE &mdash; BACK TO HOME'), mount: function () {
    mountSessionSummary(sessId, function () { F = null; go('dashboard'); });
  }};
};

/* --- PAST SESSION VIEW: reopen any finished session from COUNT SESSIONS --- */
Screens['count/session'] = function (sessId) {
  var sess = findFreeSession(sessId);
  if (!sess) { setTimeout(function () { go('count/sessions'); }, 0); return { html: '' }; }
  return { html: sessionSummaryHtml(sessId, '&larr; BACK TO SESSIONS'), mount: function () {
    mountSessionSummary(sessId, function () { go('count/sessions'); });
  }};
};

/* --- COUNT SESSIONS: list of every finished Free Run pilot session --- */
Screens['count/sessions'] = function () {
  var ss = (FG().freeSessions || []).slice()
    .sort(function (a, b) { return new Date(b.startedAt) - new Date(a.startedAt); });
  var rows = ss.map(function (s) {
    var m = sessionMetrics(s.id);
    return '<button class="sessrow" data-sess="' + esc(s.id) + '">' +
      '<div class="sessrow-top"><span class="mono"><b>' + esc(s.id) + '</b></span>' +
      '<span class="sub">' + esc(new Date(s.startedAt).toLocaleDateString()) + '</span></div>' +
      '<div class="sessrow-sub">' + esc(s.startedBy || '—') +
      ' &middot; ' + m.rolls + ' rolls &middot; ' + m.locations + ' locations' +
      ' &middot; ' + fmtDur(m.totalMs) +
      (m.discrepancies ? ' &middot; <span style="color:var(--red)">' + m.discrepancies + ' need review</span>' : '') +
      '</div></button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; HOME</button>' +
    '<div class="step-head">PILOT SESSIONS</div>' +
    '<h1>&#128203; COUNT SESSIONS</h1>' +
    '<p class="hint">Finished Free Run cycle-count sessions. Open one for its summary, manager report, and exports.</p>' +
    (rows || '<div class="hint center">No finished sessions yet.</div>') +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { go('dashboard'); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-sess]'), function (b) {
      b.onclick = function () { go('count/session', b.getAttribute('data-sess')); };
    });
  }};
};

/* --- SESSION SUMMARY (§5): shared renderer for free-summary + sessview --- */

/* ---- prototype lines 1954-2035 ---- */
function sessionSummaryHtml(sessId, doneLabel) {
  var sess = findFreeSession(sessId) || {};
  var m = sessionMetrics(sessId);
  var counts = freeCountsFor(sessId).slice()
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  var locs = [], disc = [];
  counts.forEach(function (c) {
    if (locs.indexOf(c.location) < 0) locs.push(c.location);
    if (c.discovered && disc.indexOf(c.rollId) < 0) disc.push(c.rollId);
  });
  function kv(k, v) {
    return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  }
  var rows = counts.map(function (c) {
    return '<div class="trow">' +
      '<div class="mono"><b>' + esc(c.location) + '</b></div>' +
      '<div class="mono">' + esc(c.rollId) + (c.discovered ? ' <span class="stchip st-blue">NEW</span>' : '') + '</div>' +
      '<div class="num">' + fmtLen(c.physicalIn) + '</div>' +
      '<div class="center">✓</div>' +
      '<div class="sub">' + esc(c.time) + '</div></div>';
  }).join('');
  var discRows = disc.map(function (id) {
    var d = findDiscovered(id);
    if (!d) return '';
    var ddocs = docsForRoll(d.id);
    return '<div class="card">' +
      '<div class="kv"><span class="k">Roll Barcode</span><span class="v mono">' + esc(d.id) + '</span></div>' +
      '<div class="kv"><span class="k">Physical Location</span><span class="v mono">' + esc(d.lastLocation || '—') + '</span></div>' +
      '<div class="kv"><span class="k">Measured Balance</span><span class="v num">' +
        (d.lastMeasuredIn != null ? fmtLen(d.lastMeasuredIn) : '—') + '</span></div>' +
      '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(d.lastMeasuredBy || d.firstSeenBy || '—') + '</span></div>' +
      '<div class="kv"><span class="k">Date</span><span class="v">' + esc(new Date(d.lastMeasuredAt || d.firstSeenAt).toLocaleDateString()) + '</span></div>' +
      '<div class="kv"><span class="k">Time</span><span class="v">' + esc(d.lastMeasuredAt ? fmtTime(d.lastMeasuredAt) : fmtTime(d.firstSeenAt)) + '</span></div>' +
      (ddocs.length
        ? '<div class="kv"><span class="k">History Cards</span><span class="v">&#128247; ' + ddocs.length +
          ' &middot; <button class="btn btn-xs" data-docview="' + esc(ddocs[0].id) + '">VIEW</button></span></div>'
        : '') +
      '</div>';
  }).join('');
  var locChips = locs.map(function (l) { return '<span class="stchip st-blue" style="font-size:1.1rem">' + esc(l) + '</span>'; }).join(' ');
  var html =
    '<div class="screen">' +
    '<div class="step-head">FREE RUN &mdash; DISCOVERY MODE</div>' +
    '<h1>&#10003; CYCLE COUNT COMPLETE</h1>' +
    '<div class="card">' +
      kv('Employee', esc(sess.startedBy || '—')) +
      kv('Session', '<span class="mono">' + esc(sessId) + '</span>') +
      kv('Started', sess.startedAt ? fmtDT(sess.startedAt) : '—') +
      kv('Completed', sess.endedAt ? fmtDT(sess.endedAt) : '—') +
      kv('Duration', fmtDur(m.totalMs)) +
      kv('Locations Counted', '<span class="num">' + m.locations + '</span>') +
      kv('Rolls Counted', '<span class="num">' + m.rolls + '</span>') +
      kv('Measured Balances', '<span class="num">' + m.rolls + '</span>') +
      kv('History Cards Captured', '<span class="num">&#128247; ' + m.historyCards + '</span>') +
      kv('Discrepancies', '<span class="num">' + m.discrepancies + '</span>') +
      kv('Needs Review', '<span class="num">' + m.needsReview + '</span>') +
    '</div>' +
    '<button class="btn btn-primary btn-huge" id="sreport">&#128202; VIEW MANAGER REPORT</button>' +
    '<button class="btn" id="sexport">&#8681; EXPORT REPORT</button>' +
    '<div class="h2">Collected Counts</div>' +
    '<div class="thead trow"><div>LOCATION</div><div>ROLL</div><div>MEASURED</div><div>MB</div><div>TIME</div></div>' +
    (rows || '<div class="hint center">No rolls counted in this session.</div>') +
    '<div class="h2">Discovered Rolls</div>' +
    (discRows || '<div class="hint center">No new rolls discovered.</div>') +
    '<div class="h2">Discovered Locations</div>' +
    '<div class="card">' + (locChips || '<span class="hint">None.</span>') + '</div>' +
    '<button class="btn btn-primary btn-huge" id="fdone">' + doneLabel + '</button>' +
    '</div>';
  return html;
}
function mountSessionSummary(sessId, onDone) {
  $('#fdone').onclick = onDone;
  $('#sreport').onclick = function () { go('count/report', sessId); };
  $('#sexport').onclick = function () { go('count/export', sessId); };
  wireDocViews();
}

/* ================= MANAGER REPORT (§6) =================
   Professional per-session warehouse report over reportRows():
   filterable table + ITEMS REQUIRING REVIEW + tap-through roll detail.
   Read-only: nothing here changes counts, balances, or inventory. */
var REPORT_FILTERS = ['ALL', 'MATCH', 'SHORT', 'OVER', 'NEEDS REVIEW', 'NEWLY DISCOVERED'];

/* ---- prototype lines 2036-2317 ---- */
function reportFilterLabel(f) {
  var m = { ALL: 'All', MATCH: 'Match', SHORT: 'Short', OVER: 'Over',
            'NEEDS REVIEW': 'Needs Review', 'NEWLY DISCOVERED': 'Newly Discovered' };
  return m[f] || f;
}

function reportRowHtml(r) {
  var target = r.discovered ? 'disc' : 'roll';
  return '<tr data-goto="' + target + '" data-roll="' + esc(r.rollId) + '">' +
    '<td class="mono"><b>' + esc(r.loc) + '</b></td>' +
    '<td class="mono">' + esc(r.rollId) + (r.discovered ? ' <span class="stchip st-blue">NEW</span>' : '') + '</td>' +
    '<td>' + esc(r.style) + '</td>' +
    '<td>' + esc(r.color) + '</td>' +
    '<td class="num">' + (r.expectedIn != null ? fmtLen(r.expectedIn) : '<span class="sub">—</span>') + '</td>' +
    '<td class="num"><b>' + fmtLen(r.physicalIn) + '</b></td>' +
    '<td class="num ' + (r.diffIn == null ? '' : diffCls(r.diffIn)) + '">' +
      (r.diffIn == null ? '<span class="sub">—</span>' : fmtDiff(r.diffIn)) + '</td>' +
    '<td class="center">✓</td>' +
    '<td class="center">' + (r.docs ? '&#128247; ' + r.docs : '<span class="sub">—</span>') + '</td>' +
    '<td>' + statusChip(r.status) + '</td>' +
    '<td class="sub">' + esc(r.time) + '</td></tr>';
}
function reportTableHtml(rows) {
  if (!rows.length) return '<div class="hint center">No rows match this filter.</div>';
  return '<div class="rtable-wrap"><table class="rtable"><thead><tr>' +
    '<th>LOCATION</th><th>ROLL</th><th>STYLE</th><th>COLOR</th><th>EXPECTED BALANCE</th>' +
    '<th>MEASURED BALANCE</th><th>DIFFERENCE</th><th>MB</th><th>HISTORY CARD</th><th>STATUS</th><th>TIME</th>' +
    '</tr></thead><tbody>' + rows.map(reportRowHtml).join('') + '</tbody></table></div>';
}
function filterReportRows(rows, f) {
  if (f === 'ALL') return rows;
  return rows.filter(function (r) { return r.status === f; });
}

Screens['count/report'] = function (sessId) {
  var sess = findFreeSession(sessId);
  if (!sess) { setTimeout(function () { go('count/sessions'); }, 0); return { html: '' }; }
  var rows = reportRows(sessId);
  var m = sessionMetrics(sessId);
  var cur = 'ALL';
  function chipsHtml() {
    return REPORT_FILTERS.map(function (f) {
      return '<button class="fchip' + (f === cur ? ' on' : '') + '" data-f="' + f + '">' +
        reportFilterLabel(f) + '</button>';
    }).join('');
  }
  function tableArea() {
    var fr = filterReportRows(rows, cur);
    var disc = rows.filter(isDiscrepancyRow);
    return '<div class="h2">Results <span class="sub">(' + fr.length + ' of ' + rows.length + ')</span></div>' +
      reportTableHtml(fr) +
      '<div class="h2">&#9888; ITEMS REQUIRING REVIEW <span class="sub">(' + disc.length + ')</span></div>' +
      (disc.length ? reportTableHtml(disc)
        : '<div class="hint center">Nothing needs review — every counted roll matched.</div>');
  }
  function isDiscrepancyRow(r) {
    return r.status === 'SHORT' || r.status === 'OVER' || r.status === 'LOCATION ISSUE' || r.status === 'NEEDS REVIEW';
  }
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">PILOT SESSION &mdash; MANAGER REPORT</div>' +
    '<h1>&#128202; MANAGER REPORT</h1>' +
    '<div class="card"><div class="kv"><span class="k">Session</span><span class="v mono">' + esc(sessId) + '</span></div>' +
    '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(sess.startedBy || '—') + '</span></div>' +
    '<div class="kv"><span class="k">Date</span><span class="v">' + esc(new Date(sess.startedAt).toLocaleDateString()) + '</span></div></div>' +
    '<div class="h2">Pilot Metrics</div>' +
    '<div class="card">' +
    '<div class="kv"><span class="k">Total Rolls Counted</span><span class="v num">' + m.rolls + '</span></div>' +
    '<div class="kv"><span class="k">Total Locations</span><span class="v num">' + m.locations + '</span></div>' +
    '<div class="kv"><span class="k">Avg Count Time / Roll</span><span class="v num">' + fmtDur(m.avgMs) + '</span></div>' +
    '<div class="kv"><span class="k">Total Session Time</span><span class="v num">' + fmtDur(m.totalMs) + '</span></div>' +
    '<div class="kv"><span class="k">Discrepancies</span><span class="v num">' + m.discrepancies + '</span></div>' +
    '<div class="kv"><span class="k">History Cards Digitized</span><span class="v num">&#128247; ' + m.historyCards + '</span></div>' +
    '</div>' +
    '<div class="h2">Filter</div>' +
    '<div class="fchips" id="fchips">' + chipsHtml() + '</div>' +
    '<div id="rtables">' + tableArea() + '</div>' +
    '<p class="hint center">Tap any roll row to open its full FloorGuard detail.</p>' +
    '<button class="btn" id="bexport">&#8681; EXPORT REPORT</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    $('#bexport').onclick = function () { go('count/export', sessId); };
    function wireRows() {
      Array.prototype.forEach.call(document.querySelectorAll('#rtables tr[data-goto]'), function (tr) {
        tr.onclick = function () { go(tr.getAttribute('data-goto'), tr.getAttribute('data-roll')); };
      });
    }
    function applyFilter(f) {
      cur = f;
      $('#fchips').innerHTML = chipsHtml();
      $('#rtables').innerHTML = tableArea();
      wireRows();
      wireChips();
    }
    function wireChips() {
      Array.prototype.forEach.call(document.querySelectorAll('#fchips .fchip'), function (b) {
        b.onclick = function () { applyFilter(b.getAttribute('data-f')); };
      });
    }
    wireRows();
    wireChips();
  }};
};

/* ================= EXPORT (§8) =================
   Prototype exports: PRINT/SAVE AS PDF (via the print-optimized view),
   CSV (every cycle-count row), JSON (structured FloorGuard data). */
function downloadFile(name, mime, text) {
  var blob = new Blob([text], { type: mime + ';charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}
function csvEsc(v) {
  if (v == null) return '';
  return '"' + String(v).replace(/"/g, '""') + '"';
}
function sessionExportRows(sessId) {
  var rows = reportRows(sessId);
  var head = ['session_id', 'location', 'roll', 'barcode_raw', 'style', 'color',
    'expected_in', 'measured_in', 'difference_in', 'measured_balance_mb',
    'history_cards', 'status', 'employee', 'time', 'note'];
  var lines = [head.map(csvEsc).join(',')];
  rows.forEach(function (r) {
    lines.push([
      sessId, r.loc, r.rollId, r.raw, r.style, r.color,
      r.expectedIn != null ? r.expectedIn : '',
      r.physicalIn,
      r.diffIn != null ? r.diffIn : '',
      r.mb ? 'YES' : 'NO',
      r.docs, r.status, r.employee, r.time, r.note || ''
    ].map(csvEsc).join(','));
  });
  return lines.join('\r\n');
}
function sessionExportJson(sessId) {
  var sess = findFreeSession(sessId) || {};
  var docs = (FG().documents || []).filter(function (d) { return d.sessionId === sessId; });
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    exportedBy: DB.data.currentEmployee || null,
    source: 'FLOORGUARD',
    session: {
      id: sessId, employee: sess.startedBy || null,
      startedAt: sess.startedAt || null, endedAt: sess.endedAt || null,
      metrics: sessionMetrics(sessId)
    },
    rows: reportRows(sessId).map(function (r) {
      return {
        location: r.loc, rollId: r.rollId, barcodeRaw: r.raw,
        style: r.style, color: r.color,
        expectedIn: r.expectedIn, measuredIn: r.physicalIn, differenceIn: r.diffIn,
        measuredBalance: r.mb, historyCards: r.docs, historyCardIds: r.docIds,
        status: r.status, employee: r.employee, time: r.time, at: r.at,
        discovered: r.discovered, needsReview: r.needsReview,
        locationIssue: r.locationIssue, note: r.note || null
      };
    }),
    documents: docs.map(function (d) {
      return {
        id: d.id, rollId: d.rollId, num: d.num, kind: d.docType,
        capturedAt: d.at, capturedBy: d.employee, location: d.location,
        sessionId: d.sessionId, source: d.source,
        imports: (d.imports || []).map(function (i) {
          return { fields: i.fields || null, confirmedAt: i.confirmedAt || null, confirmedBy: i.confirmedBy || null };
        })
      };
    })
  }, null, 2);
}

Screens['count/export'] = function (sessId) {
  var sess = findFreeSession(sessId);
  if (!sess) { setTimeout(function () { go('count/sessions'); }, 0); return { html: '' }; }
  var fname = 'floorguard-session-' + sessId;
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">PILOT SESSION &mdash; EXPORT</div>' +
    '<h1>&#8681; EXPORT REPORT</h1>' +
    '<p class="hint">Session <span class="mono">' + esc(sessId) + '</span> &middot; ' +
      esc(sess.startedBy || '—') + ' &middot; ' + esc(new Date(sess.startedAt).toLocaleDateString()) + '</p>' +
    '<button class="btn btn-primary btn-huge" id="xpdf">&#128438; PRINT / SAVE AS PDF</button>' +
    '<p class="hint">Opens the management-review layout. On iPhone: Share &rarr; Save to Files to keep a PDF.</p>' +
    '<button class="btn btn-huge" id="xcsv">&#8681; DOWNLOAD CSV</button>' +
    '<p class="hint">Every cycle-count row — opens in Excel / Sheets.</p>' +
    '<button class="btn btn-huge" id="xjson">&#8681; DOWNLOAD JSON</button>' +
    '<p class="hint">Structured FloorGuard data for future integration and testing.</p>' +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    $('#xpdf').onclick = function () { go('count/report/print', sessId); };
    $('#xcsv').onclick = function () { downloadFile(fname + '.csv', 'text/csv', sessionExportRows(sessId)); good(); };
    $('#xjson').onclick = function () { downloadFile(fname + '.json', 'application/json', sessionExportJson(sessId)); good(); };
  }};
};

/* ================= PRINT REPORT (§8 PDF) =================
   Print-optimized management review. window.print() -> Save as PDF. */
Screens['count/report/print'] = function (sessId) {
  var sess = findFreeSession(sessId);
  if (!sess) { setTimeout(function () { go('count/sessions'); }, 0); return { html: '' }; }
  var rows = reportRows(sessId);
  var m = sessionMetrics(sessId);
  var docs = (FG().documents || []).filter(function (d) { return d.sessionId === sessId; })
    .sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  function trow(cells) {
    return '<tr>' + cells.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
  }
  var dataRows = rows.map(function (r) {
    return trow([
      esc(r.loc), esc(r.rollId), esc(r.style), esc(r.color),
      r.expectedIn != null ? fmtLen(r.expectedIn) : '—',
      fmtLen(r.physicalIn),
      r.diffIn == null ? '—' : fmtDiff(r.diffIn),
      r.mb ? 'YES' : 'NO',
      r.docs ? r.docs + ' card' + (r.docs > 1 ? 's' : '') : '—',
      esc(r.status), esc(r.time)
    ]);
  }).join('');
  var discRows = rows.filter(function (r) {
    return r.status === 'SHORT' || r.status === 'OVER' || r.status === 'LOCATION ISSUE' || r.status === 'NEEDS REVIEW';
  }).map(function (r) {
    return trow([esc(r.loc), esc(r.rollId),
      r.expectedIn != null ? fmtLen(r.expectedIn) : '—',
      fmtLen(r.physicalIn),
      r.diffIn == null ? '—' : fmtDiff(r.diffIn),
      esc(r.status), esc(r.note || '—')]);
  }).join('');
  var docRows = docs.map(function (d) {
    return trow(['<b>' + esc(d.rollId) + '</b>', 'HISTORY CARD #' + d.num,
      esc(d.employee || '—'), d.at ? new Date(d.at).toLocaleString() : '—',
      esc(d.location || '—')]);
  }).join('');
  var html =
    '<div class="screen print-report">' +
    '<div class="noprint"><button class="backbtn" id="back">&larr; BACK</button>' +
    '<button class="btn btn-primary btn-huge" id="doprint">&#128438; PRINT / SAVE AS PDF</button></div>' +
    '<h1>FLOORGUARD &mdash; CYCLE COUNT MANAGER REPORT</h1>' +
    '<div class="sub">Generated ' + new Date().toLocaleString() + ' by ' + esc(DB.data.currentEmployee || '—') + '</div>' +
    '<h2>Session</h2>' +
    '<table class="ptable"><tbody>' +
    trow(['<b>Session ID</b>', esc(sessId)]) +
    trow(['<b>Employee</b>', esc(sess.startedBy || '—')]) +
    trow(['<b>Started</b>', sess.startedAt ? fmtDT(sess.startedAt) : '—']) +
    trow(['<b>Completed</b>', sess.endedAt ? fmtDT(sess.endedAt) : '—']) +
    trow(['<b>Duration</b>', fmtDur(m.totalMs)]) +
    '</tbody></table>' +
    '<h2>Pilot Metrics</h2>' +
    '<table class="ptable"><tbody>' +
    trow(['<b>Total Rolls Counted</b>', m.rolls]) +
    trow(['<b>Total Locations</b>', m.locations]) +
    trow(['<b>Average Count Time / Roll</b>', fmtDur(m.avgMs)]) +
    trow(['<b>Total Session Time</b>', fmtDur(m.totalMs)]) +
    trow(['<b>Discrepancies</b>', m.discrepancies]) +
    trow(['<b>Needs Review</b>', m.needsReview]) +
    trow(['<b>History Cards Digitized</b>', m.historyCards]) +
    '</tbody></table>' +
    '<h2>Count Results</h2>' +
    '<table class="ptable"><thead><tr><th>Location</th><th>Roll</th><th>Style</th><th>Color</th>' +
    '<th>Expected</th><th>Measured</th><th>Diff</th><th>MB</th><th>Hist. Card</th><th>Status</th><th>Time</th></tr></thead>' +
    '<tbody>' + (dataRows || trow(['<i>No rolls counted.</i>'])) + '</tbody></table>' +
    '<h2>Items Requiring Review</h2>' +
    '<table class="ptable"><thead><tr><th>Location</th><th>Roll</th><th>Expected</th><th>Measured</th>' +
    '<th>Diff</th><th>Status</th><th>Note</th></tr></thead>' +
    '<tbody>' + (discRows || trow(['<i>Nothing needs review.</i>'])) + '</tbody></table>' +
    '<h2>History Card Documents</h2>' +
    '<table class="ptable"><thead><tr><th>Roll ID</th><th>Document</th><th>Captured By</th><th>Captured At</th><th>Location</th></tr></thead>' +
    '<tbody>' + (docRows || trow(['<i>No history cards captured in this session.</i>'])) + '</tbody></table>' +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    $('#doprint').onclick = function () { window.print(); };
  }};
};

/* --- DISCOVERED ROLL DETAIL (§7 for never-before-seen rolls) --- */

/* ---- prototype lines 2318-2369 ---- */
Screens['disc'] = function (rollId) {
  return rollDiscoveredScreen(rollId);
};
function rollDiscoveredScreen(rollId) {
  var d = findDiscovered(rollId);
  if (!d) { setTimeout(function () { history.back(); }, 0); return { html: '' }; }
  var ddocs = docsForRoll(d.id);
  var counts = (FG().freeCounts || []).filter(function (c) { return c.rollId === d.id; })
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  var countRows = counts.map(function (c) {
    return '<div class="trow"><div class="mono"><b>' + esc(c.location) + '</b></div>' +
      '<div class="num">' + fmtLen(c.physicalIn) + '</div>' +
      '<div>' + statusChip(freeCountStatus(c)) + '</div>' +
      '<div class="sub">' + esc(c.time) + '</div></div>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">ROLL DETAIL &mdash; DISCOVERED</div>' +
    '<h1 class="mono">' + esc(d.id) + '</h1>' +
    '<div><span class="stchip st-blue">NEWLY DISCOVERED</span></div>' +
    '<div class="h2">Roll Information</div>' +
    '<div class="card">' +
    '<div class="kv"><span class="k">Barcode</span><span class="v mono">' + esc(d.id) + '</span></div>' +
    '<div class="kv"><span class="k">Current Location</span><span class="v mono">' + esc(d.lastLocation || '—') + '</span></div>' +
    '<div class="kv"><span class="k">Measured Balance</span><span class="v num">' +
      (d.lastMeasuredIn != null ? fmtLen(d.lastMeasuredIn) : '—') + ' ✓</span></div>' +
    '<div class="kv"><span class="k">Style / Color</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>' +
    '<div class="kv"><span class="k">First Seen</span><span class="v">' + esc(d.firstSeenBy || '—') + ' &middot; ' + fmtDT(d.firstSeenAt) + '</span></div>' +
    '</div>' +
    '<div class="h2">History Card Images</div>' +
    (ddocs.length ? docsHtml(ddocs) : '<div class="hint center">No history cards captured for this roll.</div>') +
    '<div class="h2">Cycle Counts</div>' +
    '<div class="thead trow"><div>LOCATION</div><div>MEASURED</div><div>STATUS</div><div>TIME</div></div>' +
    (countRows || '<div class="hint center">No counts recorded.</div>') +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    wireDocViews();
  }};
};

/* ---------------- HISTORY CARD SCAN / DOCUMENT CAPTURE -------------------------
   Preserve the handwritten paper history cards attached to carpet rolls and
   connect each photo to the correct Roll ID inside FloorGuard.
   WORKFLOW: scan roll -> open roll record -> SCAN HISTORY CARD -> take photo ->
   USE PHOTO -> SAVE -> photo becomes part of the roll's permanent record.
   - Originals are never overwritten: each capture becomes HISTORY CARD #1, #2...
   - Capture uses a plain file-input camera picker, NOT the barcode scanners.
     The roll/location scanner implementations are untouched.
   - Optional smart extraction is review-first: nothing extracted is ever
     treated as confirmed data until a human taps CONFIRM; confirmed imports
     are labeled PAPER CARD IMPORT and never change expected balances.
   - Data source labels: FLOORGUARD (digital activity), PAPER CARD (the photo),
     PAPER CARD IMPORT (confirmed extracted data), REAL FLOORS (future API). */

/* ---- prototype lines 2370-2413 ---- */
var D = null; /* transient capture context; images live here until saved */

function newDocCapture(rollId, opts) {
  opts = opts || {};
  var roll = rollByBarcode(rollId);
  D = {
    rollId: String(rollId),
    barcode: roll ? roll.barcode : String(rollId || '').trim().toUpperCase(),
    discovered: !roll,
    location: opts.location || (roll ? roll.expectedLocation : '') || '',
    returnTo: opts.returnTo || null, /* {name, param} after a fresh save */
    image: null, thumb: null,
    docId: null, fresh: false, saveError: ''
  };
}
function docsForRoll(rollId) {
  return (FG().documents || []).filter(function (d) { return d.rollId === rollId; })
    .sort(function (a, b) { return a.at < b.at ? -1 : 1; });
}
function findDoc(id) {
  var ds = FG().documents || [];
  for (var i = 0; i < ds.length; i++) if (ds[i].id === id) return ds[i];
  return null;
}
/* Downscale a captured photo to a JPEG data URL so device-local storage stays
   small. The downscaled image IS the preserved original: it is written once
   and never re-compressed or overwritten afterwards. */
function downscaleImage(dataUrl, maxDim, quality, cb) {
  var img = new Image();
  img.onload = function () {
    try {
      var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      var cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cb(cv.toDataURL('image/jpeg', quality));
    } catch (e) { cb(null); }
  };
  img.onerror = function () { cb(null); };
  img.src = dataUrl;
}
/* Persist with real quota errors instead of DB.save()'s silent catch, so a
   full device tells the truth instead of pretending the photo was saved. */

/* ---- prototype lines 2414-2416 ---- */
function persistOrThrow() { DB.save(); }

/* ---- prototype lines 2419-2580 ---- */
Screens['roll/doc'] = function () {
  if (!D || !D.rollId) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var rt = D.returnTo;
  var html =
    '<div class="screen">' +
    '<div class="step-head">HISTORY CARD SCAN</div>' +
    '<div class="card" style="text-align:center">' +
      '<div class="label">HISTORY CARD FOR ROLL</div>' +
      '<div class="mono" style="font-size:2rem;font-weight:900">' + esc(D.rollId) + '</div>' +
      (D.discovered ? '<div><span class="stchip st-blue">DISCOVERED ROLL</span></div>' : '') +
    '</div>' +
    '<p class="hint">Photograph the handwritten paper history card attached to this roll. The photo becomes part of the roll&rsquo;s permanent record.</p>' +
    '<input type="file" id="docfile" accept="image/*" capture="environment" hidden>' +
    '<button class="btn btn-primary btn-huge" id="takephoto">&#128247; TAKE PHOTO</button>' +
    '<button class="btn btn-ghost" id="dccancel">CANCEL</button>' +
    '<div class="err" id="dcerr" hidden></div>' +
    '</div>';
  return { html: html, mount: function () {
    $('#takephoto').onclick = function () { $('#docfile').click(); };
    $('#dccancel').onclick = function () { D = null; if (rt) go(rt.name, rt.param); else history.back(); };
    $('#docfile').onchange = function () {
      var f = $('#docfile').files[0];
      if (!f) return;
      var e = $('#dcerr'); e.hidden = true;
      var rd = new FileReader();
      rd.onload = function () {
        downscaleImage(rd.result, 1280, 0.72, function (img) {
          if (!img) { bad(); e.textContent = 'Could not read that photo. Try again.'; e.hidden = false; return; }
          downscaleImage(rd.result, 320, 0.6, function (th) {
            D.image = img; D.thumb = th || img;
            good(); go('roll/doc/review');
          });
        });
      };
      rd.onerror = function () { bad(); e.textContent = 'Could not read that photo. Try again.'; e.hidden = false; };
      rd.readAsDataURL(f);
    };
  }};
};

/* --- STEP 2: review the photo, then USE PHOTO / RETAKE / CANCEL --- */
Screens['roll/doc/review'] = function () {
  if (!D || !D.image) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var html =
    '<div class="screen">' +
    '<div class="step-head">HISTORY CARD SCAN</div>' +
    '<h1>Review photo</h1>' +
    '<div class="card" style="text-align:center"><img src="' + D.image + '" style="max-width:100%;border-radius:8px"></div>' +
    '<div class="field"><label class="label" for="docloc">LOCATION (IF KNOWN)</label>' +
    '<input class="input mono" id="docloc" autocomplete="off" autocapitalize="characters" value="' + esc(D.location) + '" placeholder="e.g. 205B"></div>' +
    (D.saveError ? '<div class="err">' + esc(D.saveError) + '</div>' : '') +
    '<button class="btn btn-primary btn-huge" id="usephoto">&#10003; USE PHOTO</button>' +
    '<div class="btn-row">' +
      '<button class="btn" id="retake" style="flex:1">&#8635; RETAKE</button>' +
      '<button class="btn btn-ghost" id="dcancel2" style="flex:1">CANCEL</button>' +
    '</div>' +
    '</div>';
  return { html: html, mount: function () {
    $('#usephoto').onclick = function () {
      D.location = normLoc($('#docloc').value) || $('#docloc').value.trim();
      saveDocument();
    };
    $('#retake').onclick = function () { go('roll/doc'); };
    $('#dcancel2').onclick = function () {
      var rt = D.returnTo; D = null;
      if (rt) go(rt.name, rt.param); else history.back();
    };
  }};
};

function saveDocument() {
  /* Run 4 shared mode: private storage upload + metadata rows (atomic),
     then refresh so the authoritative doc shows up. */
  if (dataMode() === 'shared' && typeof SharedRepo !== 'undefined') {
    SharedRepo.uploadHistoryCard({
      rollId: D.rollId, imageDataUrl: D.image, mimeType: 'image/jpeg',
      employee: DB.data.currentEmployee, location: D.location || null,
      sessionId: (typeof F !== 'undefined' && F && F.id && !F.endedAt) ? F.id : null
    }).then(function (r) {
      return Repository.refresh({ quiet: true }).then(function () { return r; });
    }).then(function (r) {
      D.docId = r.docId; D.fresh = true;
      D.image = null; D.thumb = null; D.saveError = '';
      good();
      go('doc', r.docId);
    }).catch(function (err) {
      bad();
      D.saveError = (err && (err.code === 'OFFLINE' || err.code === 'NETWORK'))
        ? 'OFFLINE — HISTORY CARD NOT SYNCED. Reconnect and tap USE PHOTO again.'
        : ((err && err.message) || 'Upload failed. Tap USE PHOTO to retry.');
      render();
    });
    return;
  }
  var now = new Date();
  var rec = {
    id: 'D' + now.getTime().toString(36).toUpperCase(),
    rollId: D.rollId, barcode: D.barcode, raw: D.barcode,
    discovered: D.discovered,
    kind: 'HISTORY_CARD', docType: 'HISTORY CARD',
    image: D.image, thumb: D.thumb,
    employee: DB.data.currentEmployee,
    at: now.toISOString(), date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
    location: D.location || null,
    source: 'PAPER CARD',
    num: docsForRoll(D.rollId).length + 1,
    imports: [], /* confirmed smart-extractions, added later via doc-extract */
    /* Pilot session link: which count session this card was digitized in.
       Stamped only when a Free Run session is active; otherwise null. */
    sessionId: (typeof F !== 'undefined' && F && F.id && !F.endedAt) ? F.id : null
  };
  FG().documents.push(rec);
  try { persistOrThrow(); }
  catch (e) {
    /* Quota/full storage: roll the record back and say so on the review
       screen. The photo is NOT lost from the worker's hands — they can retry. */
    FG().documents.pop();
    bad();
    D.saveError = 'Device storage is full — the photo could not be saved. Free up space and tap USE PHOTO again.';
    return;
  }
  D.docId = rec.id; D.fresh = true;
  D.image = null; D.thumb = null; /* free the big in-memory strings */
  D.saveError = '';
  good();
  go('doc', rec.id);
}

/* --- Saved document: full record, VIEW ORIGINAL, optional extraction --- */
Screens['doc'] = function (param) {
  var doc = findDoc(param);
  if (!doc) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var imports = (doc.imports || []).map(function (imp) {
    return '<div class="card"><div class="kv"><span class="k">Status</span>' +
      '<span class="v"><span class="srcchip src-import">PAPER CARD IMPORT</span></span></div>' +
      importFieldsHtml(imp.fields) +
      '<div class="sub">Confirmed by ' + esc(imp.confirmedBy) + ' &middot; ' + fmtDT(imp.confirmedAt) + '</div></div>';
  }).join('');
  var freshContinue = D && D.fresh && D.docId === doc.id && D.returnTo;
  var html =
    '<div class="screen">' +
    '<div class="step-head">ROLL DOCUMENT</div>' +
    '<h1 class="mono">HISTORY CARD #' + doc.num + '</h1>' +
    '<div class="card" style="text-align:center">' +
      '<img id="docimg" style="max-width:100%;border-radius:8px"' +
        (doc.thumb ? ' src="' + doc.thumb + '"' : ' alt="Loading history card…"') + '>' +
      '<div class="hint" id="docloading"' + (doc.thumb ? ' hidden' : '') + '>Loading history card…</div>' +
      '<br><button class="btn" id="vieworig" style="margin-top:10px">&#128269; VIEW ORIGINAL</button>' +
    '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll</span><span class="v mono">' + esc(doc.rollId) + '</span></div>' +
      '<div class="kv"><span class="k">Document Type</span><span class="v">' + esc(doc.docType) + '</span></div>' +
      '<div class="kv"><span class="k">Captured</span><span class="v">' + esc(doc.date) + ' &middot; ' + esc(doc.time) + '</span></div>' +
      '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(doc.employee) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(doc.location || '&mdash;') + '</span></div>' +
      '<div class="kv"><span class="k">Source</span><span class="v"><span class="srcchip">PAPER CARD</span></span></div>' +
    '</div>' +
    imports +
    '<button class="btn btn-huge" id="extract">&#10024; EXTRACT HISTORY FROM CARD</button>' +
    (freshContinue
      ? '<button class="btn btn-primary btn-huge" id="doccontinue">CONTINUE &rarr;</button>'
      : '<button class="btn btn-ghost" id="docback">&larr; BACK</button>') +
    '<div id="docoverlay" class="doc-overlay" hidden><img id="docfull" alt="History card original"><div class="hint" style="color:#fff">Tap to close</div></div>' +
    '</div>';
  return { html: html, mount: function () {
    /* Run 4 shared mode: the original lives in private storage; fetch it
       into memory only (never into localStorage). */
    if (!doc.thumb && !doc.image && dataMode() === 'shared' && doc.storagePath &&
        typeof SharedRepo !== 'undefined') {
      SharedRepo.downloadHistoryCard(doc.storagePath).then(function (url) {
        doc._imgUrl = url; /* session-only */
        var im = $('#docimg'); if (im) im.src = url;
        var ld = $('#docloading'); if (ld) ld.hidden = true;
      }).catch(function () {
        var ld = $('#docloading'); if (ld) ld.textContent = 'Could not load the original.';
      });
    }
    $('#vieworig').onclick = function () {
      $('#docfull').src = doc._imgUrl || doc.image;
      $('#docoverlay').hidden = false;
    };
    $('#docoverlay').onclick = function () { $('#docoverlay').hidden = true; $('#docfull').removeAttribute('src'); };
    $('#extract').onclick = function () { go('doc/extract', doc.id); };
    if (freshContinue) {
      $('#doccontinue').onclick = function () { var rt = D.returnTo; D = null; go(rt.name, rt.param); };
    } else {
      $('#docback').onclick = function () { history.back(); };
    }
  }};
};

/* --- OPTIONAL SMART EXTRACTION ------------------------------------------------
   Prototype feature "EXTRACT HISTORY FROM CARD". extractFromImage() is the
   single seam where a future OCR engine plugs in. This build ships with no
   OCR engine (offline-first; no heavy deps), so auto-read reports unavailable
   and the worker reads the card and enters values — the review screen,
   UNVERIFIED labeling, and CONFIRM / EDIT / IGNORE workflow are identical
   either way. Nothing extracted ever becomes confirmed data without CONFIRM,
   and confirmed imports NEVER change expected balances. */

/* ---- prototype lines 2581-2602 ---- */
function extractFromImage(dataUrl) {
  return {
    available: false,
    fields: null,
    note: 'Auto-read is not available in this prototype build — read the card above and enter the values below.'
  };
}
function readExtractFields() {
  function num(id) { var v = parseFloat(($('#' + id).value || '').trim()); return isNaN(v) ? null : v; }
  function ftin(ftId, inId) {
    var ft = num(ftId), inch = num(inId);
    if (ft == null && inch == null) return null;
    return { ft: ft || 0, inch: inch || 0, totalIn: Math.round((ft || 0) * 12 + (inch || 0)) };
  }
  return {
    job: $('#xjob').value.trim(), order: $('#xorder').value.trim(),
    cut: ftin('xcutft', 'xcutin'), balance: ftin('xbalft', 'xbalin'),
    measured: ftin('xmbft', 'xmbin'),
    date: $('#xdate').value.trim(), size: $('#xsize').value.trim(),
    notes: $('#xnotes').value.trim()
  };
}

/* ---- prototype lines 2603-2694 ---- */
function importFieldsHtml(f) {
  var rows = [];
  if (f.job) rows.push(['Job Number', esc(f.job)]);
  if (f.order) rows.push(['Order Number', esc(f.order)]);
  if (f.cut) rows.push(['Cut', '<span class="num">' + fmtLen(f.cut.totalIn) + '</span>']);
  if (f.balance) rows.push(['Balance', '<span class="num">' + fmtLen(f.balance.totalIn) + '</span>']);
  if (f.measured) rows.push(['Measured Balance', '<span class="num">' + fmtLen(f.measured.totalIn) + '</span> <span class="stchip st-green">MB &#10003;</span>']);
  if (f.date) rows.push(['Date', esc(f.date)]);
  if (f.size) rows.push(['Size', esc(f.size)]);
  if (f.notes) rows.push(['Notes', esc(f.notes)]);
  if (!rows.length) return '<div class="sub">No values entered.</div>';
  return rows.map(function (r) {
    return '<div class="kv"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>';
  }).join('');
}
Screens['doc/extract'] = function (param) {
  var doc = findDoc(param);
  if (!doc) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var ext = extractFromImage(doc.image);
  var pre = function (v) { return esc(v || ''); };
  var pf = ext.fields || {};
  var html =
    '<div class="screen">' +
    '<div class="step-head">HISTORY CARD SCAN</div>' +
    '<h1>Extract history</h1>' +
    '<div class="card" style="border:2px solid var(--yellow)">' +
      '<div style="font-weight:900;color:var(--yellow)">&#9888; UNVERIFIED IMPORTED HISTORY</div>' +
      '<div class="hint">Handwriting reads may be imperfect. Nothing here is confirmed data — review every field before confirming.</div>' +
      (ext.available ? '' : '<div class="hint">' + esc(ext.note) + '</div>') +
    '</div>' +
    '<div class="card" style="text-align:center"><img src="' + doc.thumb + '" style="max-width:100%;border-radius:8px"></div>' +
    '<div class="field"><label class="label" for="xjob">JOB NUMBER</label><input class="input mono" id="xjob" autocomplete="off" value="' + pre(pf.job) + '"></div>' +
    '<div class="field"><label class="label" for="xorder">ORDER NUMBER</label><input class="input mono" id="xorder" autocomplete="off" value="' + pre(pf.order) + '"></div>' +
    '<div class="label">CUT AMOUNT</div><div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label" for="xcutft">FEET</label><input class="input num" id="xcutft" inputmode="numeric" autocomplete="off" value="' + pre(pf.cutFt) + '"></div>' +
      '<div class="field" style="flex:1"><label class="label" for="xcutin">INCHES</label><input class="input num" id="xcutin" inputmode="decimal" autocomplete="off" value="' + pre(pf.cutIn) + '"></div></div>' +
    '<div class="label">BALANCE</div><div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label" for="xbalft">FEET</label><input class="input num" id="xbalft" inputmode="numeric" autocomplete="off" value="' + pre(pf.balFt) + '"></div>' +
      '<div class="field" style="flex:1"><label class="label" for="xbalin">INCHES</label><input class="input num" id="xbalin" inputmode="decimal" autocomplete="off" value="' + pre(pf.balIn) + '"></div></div>' +
    '<div class="label">MEASURED BALANCE (MB)</div><div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label" for="xmbft">FEET</label><input class="input num" id="xmbft" inputmode="numeric" autocomplete="off" value="' + pre(pf.mbFt) + '"></div>' +
      '<div class="field" style="flex:1"><label class="label" for="xmbin">INCHES</label><input class="input num" id="xmbin" inputmode="decimal" autocomplete="off" value="' + pre(pf.mbIn) + '"></div></div>' +
    '<div class="field"><label class="label" for="xdate">DATE (ON CARD)</label><input class="input" id="xdate" autocomplete="off" value="' + pre(pf.date) + '"></div>' +
    '<div class="field"><label class="label" for="xsize">SIZE</label><input class="input" id="xsize" autocomplete="off" value="' + pre(pf.size) + '"></div>' +
    '<div class="field"><label class="label" for="xnotes">NOTES</label><textarea class="input" id="xnotes" rows="3">' + pre(pf.notes) + '</textarea></div>' +
    '<button class="btn btn-primary btn-huge" id="xconfirm">&#10003; CONFIRM IMPORT</button>' +
    '<div class="btn-row">' +
      '<button class="btn" id="xedit" style="flex:1">&#9998; EDIT</button>' +
      '<button class="btn btn-ghost" id="xignore" style="flex:1">IGNORE</button>' +
    '</div>' +
    '</div>';
  return { html: html, mount: function () {
    $('#xedit').onclick = function () { $('#xjob').focus(); };
    $('#xignore').onclick = function () { history.back(); };
    $('#xconfirm').onclick = function () {
      var now = new Date();
      var fields = readExtractFields();
      /* Run 4 shared mode: the import becomes a backend history event —
         never a balance change. */
      if (dataMode() === 'shared' && typeof SharedRepo !== 'undefined') {
        SharedRepo.confirmHistoryImport({
          docId: doc.id, rollId: doc.rollId, fields: fields,
          employee: DB.data.currentEmployee, warehouseId: Repository.config.warehouseId
        }).then(function () {
          return Repository.refresh({ quiet: true });
        }).then(function () {
          good();
          go('doc', doc.id);
        }).catch(function (err) {
          bad();
          toast((err && err.message) || 'Import failed.');
        });
        return;
      }
      doc.imports.push({
        id: 'X' + now.getTime().toString(36).toUpperCase(),
        docId: doc.id,
        fields: fields,
        status: 'CONFIRMED',
        confirmedAt: now.toISOString(),
        confirmedBy: DB.data.currentEmployee
      });
      DB.save();
      good();
      go('doc', doc.id);
    };
  }};
};

/* DOCUMENTS section for the Roll History screen. */
function docsHtml(docs) {
  return docs.map(function (d) {
    return '<div class="ledger-row"><img class="doc-thumb" src="' + d.thumb + '" alt="History card thumbnail">' +
      '<div class="what"><b>HISTORY CARD #' + d.num + '</b> <span class="srcchip">PAPER CARD</span>' +
      '<div class="sub">' + esc(d.date) + ' &middot; ' + esc(d.employee) +
      (d.location ? ' &middot; loc <span class="mono">' + esc(d.location) + '</span>' : '') +
      ((d.imports || []).length ? ' &middot; ' + d.imports.length + ' import' + (d.imports.length > 1 ? 's' : '') : '') +
      '</div></div>' +
      '<div class="bal"><button class="btn btn-xs" data-docview="' + esc(d.id) + '">VIEW</button></div></div>';
  }).join('');
}

/* Wire every "VIEW DOCUMENT" / "VIEW" button rendered by ledgerHtml/docsHtml. */
function wireDocViews() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-docview]'), function (b) {
    b.onclick = function () { go('doc', b.getAttribute('data-docview')); };
  });
}

/* ---------------- RAPID CYCLE COUNT ----------------------------------------------

/* ---- prototype lines 2700-2902 ---- */
Screens['count/rapid/loc'] = function () {
  if (!R) newRapid();
  var chips = ['205A', '205B', '206A', '206B', '204A', '204B'].map(function (l) {
    return '<button class="demochip" data-code="' + esc(l) + '">' + esc(l) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">RAPID CYCLE COUNT &mdash; STEP 1</div>' +
    '<h1>Scan location</h1>' +
    '<p class="hint">Scan the rack location tag. Every roll you scan after this is counted at that location until you change it.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE LOCATION CODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. 205B">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
  }};
  function onCode(code) {
    var loc = normLoc(code);
    if (!loc) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; EMPTY SCAN &mdash; try again.</div>';
      return;
    }
    good();
    R.activeLoc = loc;
    R.lastMsg = null;
    go('count/rapid/scan');
  }
};

function rapidBanner() {
  var m = R && R.lastMsg;
  if (!m) return '';
  var color = { MATCH: 'var(--green)', SHORT: 'var(--red)', OVER: 'var(--yellow)',
                LOCATION_MISMATCH: 'var(--red)', NEEDS_REVIEW: 'var(--yellow)' }[m.status] || 'var(--yellow)';
  return '<div class="card" style="border:2px solid ' + color + ';text-align:center">' +
    '<div style="font-size:1.4rem;font-weight:900;color:' + color + '">' + esc(m.text) + '</div></div>';
}

Screens['count/rapid/scan'] = function () {
  if (!R || !R.activeLoc) { setTimeout(function () { go('count/rapid/loc'); }, 0); return { html: '' }; }
  var chips = FG().rolls.map(function (r) {
    return '<button class="demochip" data-code="' + esc(r.barcode) + '">' + esc(r.barcode) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">RAPID CYCLE COUNT</div>' +
    '<div class="card" style="text-align:center">' +
      '<div class="label">COUNTING LOCATION</div>' +
      '<div class="mono" style="font-size:2.4rem;font-weight:900">' + esc(R.activeLoc) + '</div>' +
    '</div>' +
    rapidBanner() +
    '<h1>Scan roll</h1>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE BARCODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '<div class="btn-row">' +
      '<button class="btn" id="changeloc" style="flex:1">&#8646; CHANGE LOCATION</button>' +
      '<button class="btn" id="rapiddone" style="flex:1">DONE</button>' +
    '</div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
    $('#changeloc').onclick = function () { go('count/rapid/loc'); };
    $('#rapiddone').onclick = function () { R = null; go('dashboard'); };
  }};
  function onCode(code) {
    var roll = rollByBarcode(code);
    if (!roll) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; ROLL NOT FOUND<br><span style="font-size:1rem">"' +
        esc(code) + '" is not in the system. Try again.</span></div>';
      return;
    }
    good();
    R.scan = { roll: roll };
    if (normLoc(roll.expectedLocation) !== normLoc(R.activeLoc)) go('count/rapid/mismatch');
    else go('count/rapid/balance');
  }
};

Screens['count/rapid/mismatch'] = function () {
  if (!R || !R.scan || !R.scan.roll) { setTimeout(function () { go('count/rapid/scan'); }, 0); return { html: '' }; }
  var roll = R.scan.roll;
  var html =
    '<div class="screen">' +
    '<div class="warn-panel"><h1>&#9888; LOCATION MISMATCH</h1>' +
    '<div class="vs"><div><div class="k">EXPECTED</div><div class="v mono">' + esc(roll.expectedLocation) + '</div></div>' +
    '<div><div class="k">COUNT LOCATION</div><div class="v mono">' + esc(R.activeLoc) + '</div></div></div></div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
    '</div>' +
    '<p class="hint">This roll does not belong at <b class="mono">' + esc(R.activeLoc) + '</b>. Flag it for supervisor review, or cancel and keep counting.</p>' +
    '<button class="btn btn-red btn-huge" id="flag">&#9888; FLAG FOR REVIEW</button>' +
    '<button class="btn btn-huge" id="cancel">CANCEL &rarr; KEEP COUNTING</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#flag').onclick = function () {
      var now = new Date();
      FG().counts.push({
        id: 'C' + Date.now().toString(36).toUpperCase(),
        rollId: roll.id, barcode: roll.barcode, style: roll.style, color: roll.color, widthIn: roll.widthIn,
        expectedLocation: roll.expectedLocation, scannedLocation: R.activeLoc,
        expectedIn: systemBalance(roll.id), physicalIn: null, diffIn: null,
        measured: false, /* no physical measurement taken — mismatch flagged only */
        employee: DB.data.currentEmployee, at: now.toISOString(),
        date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
        status: 'LOCATION_MISMATCH', flagged: true
      });
      DB.save();
      bad();
      R.lastMsg = { status: 'LOCATION_MISMATCH', text: '⚠ MISMATCH — ' + roll.id + ' flagged for review' };
      R.scan = null;
      go('count/rapid/scan');
    };
    $('#cancel').onclick = function () { R.scan = null; go('count/rapid/scan'); };
  }};
};

Screens['count/rapid/balance'] = function () {
  if (!R || !R.scan || !R.scan.roll) { setTimeout(function () { go('count/rapid/scan'); }, 0); return { html: '' }; }
  var roll = R.scan.roll, sys = systemBalance(roll.id);
  var html =
    '<div class="screen">' +
    '<div class="step-head">RAPID CYCLE COUNT &mdash; ' + esc(R.activeLoc) + '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(R.activeLoc) + '</span></div>' +
      '<div class="kv"><span class="k">EXPECTED BALANCE' +
        (isTestBalance(roll) ? ' <span class="stchip st-yellow">TEST</span>' : '') +
        '</span><span class="v num" style="font-size:2rem">' + fmtLen(sys) + '</span></div>' +
    '</div>' +
    '<div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">FEET</label>' +
      '<input class="input num" id="rft" inputmode="numeric" autocomplete="off" placeholder="0" style="font-size:2.2rem;min-height:84px;text-align:center"></div>' +
      '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
      '<input class="input num" id="rin" inputmode="decimal" autocomplete="off" placeholder="0" style="font-size:2.2rem;min-height:84px;text-align:center"></div>' +
    '</div>' +
    '<div class="err" id="rerr" hidden></div>' +
    '<button class="btn btn-primary btn-huge" id="savenext">&#10003; SAVE &amp; NEXT</button>' +
    '<button class="btn" id="rback">&larr; BACK TO SCANNER</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#rback').onclick = function () { R.scan = null; go('count/rapid/scan'); };
    $('#savenext').onclick = function () {
      var ft = parseFloat($('#rft').value), inch = parseFloat($('#rin').value);
      var err = '';
      if ($('#rft').value.trim() === '' && $('#rin').value.trim() === '') err = 'Enter feet and/or inches.';
      else if (isNaN(ft) || isNaN(inch) || ft < 0 || inch < 0) err = 'Numbers must be zero or more.';
      if (err) { bad(); var e = $('#rerr'); e.textContent = err; e.hidden = false; return; }
      var physicalIn = Math.round(ft * 12 + inch);
      var diff = physicalIn - sys;
      var status = computeStatus(roll, R.activeLoc, physicalIn, false);
      /* Run 4 shared mode: atomic backend write, then refresh. */
      if (dataMode() === 'shared' && typeof SharedRepo !== 'undefined') {
        sharedRecordCount({
          rollId: roll.id, scannedLocation: R.activeLoc, expectedIn: sys,
          physicalIn: physicalIn, status: status, employee: DB.data.currentEmployee
        }).then(function (r) {
          if (status === 'MATCH') good(); else bad();
          var sym = status === 'MATCH' ? '✓' : (status === 'SHORT' ? '▼' : '▲');
          R.lastMsg = { status: status, text: sym + ' ' + status + ' ' + fmtDiff(diff) + ' — ' + roll.id };
          R.scan = null;
          go('count/rapid/scan'); /* straight back to the scanner — never home */
        }).catch(function (err) {
          bad();
          countOffline(err, { kind: 'count', payload: {
            rollId: roll.id, scannedLocation: R.activeLoc, expectedIn: sys,
            physicalIn: physicalIn, status: status, employee: DB.data.currentEmployee,
            warehouseId: Repository.config.warehouseId
          }});
        });
        return;
      }
      var now = new Date();
      FG().counts.push({
        id: 'C' + Date.now().toString(36).toUpperCase(),
        rollId: roll.id, barcode: roll.barcode, style: roll.style, color: roll.color, widthIn: roll.widthIn,
        expectedLocation: roll.expectedLocation, scannedLocation: R.activeLoc,
        expectedIn: sys, physicalIn: physicalIn, diffIn: diff,
        measured: true, /* MB: worker physically measured this roll */
        employee: DB.data.currentEmployee, at: now.toISOString(),
        date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
        status: status, flagged: false
      });
      roll.measuredIn = physicalIn;
      roll.measuredAt = now.toISOString();
      roll.measuredBy = DB.data.currentEmployee;
      DB.save();
      if (status === 'MATCH') good(); else bad();
      var sym = status === 'MATCH' ? '✓' : (status === 'SHORT' ? '▼' : '▲');
      R.lastMsg = { status: status, text: sym + ' ' + status + ' ' + fmtDiff(diff) + ' — ' + roll.id };
      R.scan = null;
      go('count/rapid/scan'); /* straight back to the scanner — never home */
    };
  }};
};

/* ---------------- SUPERVISOR DASHBOARD ------------------------------------------- */

/* ---- prototype lines 2903-2999 ---- */
Screens['reports'] = function () {
  var today = FG().counts.filter(function (c) { return isToday(c.at); });
  var n = function (s) { return today.filter(function (c) { return c.status === s; }).length; };
  var seen = {}, recounts = 0;
  today.forEach(function (c) {
    if (seen[c.rollId]) { if (seen[c.rollId] === 1) recounts++; seen[c.rollId]++; }
    else seen[c.rollId] = 1;
  });
  var last = today.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); })[0];
  var byEmp = {};
  today.forEach(function (c) { byEmp[c.employee] = (byEmp[c.employee] || 0) + 1; });
  var empRows = Object.keys(byEmp).sort().map(function (e) {
    return '<div class="kv"><span class="k">' + esc(e) + '</span><span class="v num">' + byEmp[e] + '</span></div>';
  }).join('') || '<p class="hint">No counts today.</p>';

  var chips = ['MATCH', 'SHORT', 'OVER', 'LOCATION_MISMATCH', 'NEEDS_REVIEW'].map(function (s) {
    return '<button class="fchip" data-f="' + s + '">' + STATUS[s].label + '</button>';
  }).join('');

  var html =
    '<div class="screen">' +
    '<div class="step-head">SUPERVISOR</div>' +
    '<h1>Dashboard &mdash; today</h1>' +
    '<div class="metric-grid">' +
      metric(today.length, 'ROLLS COUNTED') +
      metric(n('MATCH'), 'MATCHES') +
      metric(n('SHORT'), 'SHORTAGES', today.length && n('SHORT') ? 'alert' : '') +
      metric(n('OVER'), 'OVERAGES') +
      metric(n('LOCATION_MISMATCH'), 'LOCATION MISMATCH', n('LOCATION_MISMATCH') ? 'alert' : '') +
      metric(n('NEEDS_REVIEW'), 'NEEDS REVIEW', n('NEEDS_REVIEW') ? 'warnb' : '') +
      metric(recounts, 'RECOUNTS') +
      '<div class="metric"><div class="n" style="font-size:1.2rem">' + (last ? fmtTime(last.at) : '&mdash;') + '</div><div class="l">LAST COUNT TIME</div></div>' +
    '</div>' +
    '<h2>Counts by employee</h2><div class="card">' + empRows + '</div>' +
    '<button class="btn btn-huge" id="godisc">&#9888; CYCLE COUNT DISCREPANCIES' +
    (discrepancyRolls().length ? ' (' + discrepancyRolls().length + ')' : '') + '</button>' +
    '<h2>Search &amp; filter</h2>' +
    '<div class="field"><input class="input" id="dq" autocomplete="off" placeholder="Roll, location, style, color, employee, date&hellip;"></div>' +
    '<div class="chiprow" id="dchips"><button class="fchip on" data-f="">ALL</button>' + chips + '</div>' +
    '<div id="dresults"></div>' +
    '<h2>Pilot setup</h2>' +
    '<div class="card">' +
      '<button class="btn btn-red btn-huge" id="resetcounts">RESET TEST DATA</button>' +
      '<p class="hint">Reset test data clears <b>cycle counts and measured-balance (MB) markers</b> &mdash; rolls, cuts, history cards, Free Run data, test balances, and the barcode scanner are untouched.</p>' +
    '</div>' +
    '<div class="foot"><button class="linklike" id="resetdemo">Reset demo data</button></div>' +
    '</div>';
  return { html: html, mount: function () {
    var f = '';
    var apply = function () {
      var q = $('#dq').value.trim().toLowerCase();
      var list = today.filter(function (c) {
        if (f && c.status !== f) return false;
        if (!q) return true;
        return (c.rollId + ' ' + c.scannedLocation + ' ' + c.expectedLocation + ' ' +
                c.style + ' ' + c.color + ' ' + c.employee + ' ' + fmtDT(c.at)).toLowerCase().indexOf(q) >= 0;
      }).sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
      $('#dresults').innerHTML = list.length ? list.map(countRow).join('') : '<p class="hint center">No matching counts today.</p>';
      wireCountRows();
    };
    $('#dq').addEventListener('input', apply);
    Array.prototype.forEach.call(document.querySelectorAll('#dchips .fchip'), function (b) {
      b.onclick = function () {
        f = b.getAttribute('data-f');
        Array.prototype.forEach.call(document.querySelectorAll('#dchips .fchip'), function (x) {
          x.classList.toggle('on', x === b);
        });
        apply();
      };
    });
    $('#resetdemo').onclick = function () {
      if (confirm('Reset all demo data to the seeded sample?')) { FGReset(); good(); render(); }
    };
    $('#godisc').onclick = function () { go('count/review'); };
    $('#resetcounts').onclick = function () {
      var n = FG().counts.length;
      if (n === 0) { alert('No cycle counts to clear.'); return; }
      if (confirm('RESET TEST DATA?\n\nThis clears ' + n + ' saved cycle count' + (n === 1 ? '' : 's') + ' and all measured-balance (MB) markers.\n\nRoll data, cuts, test system balances, and the barcode scanner are NOT affected.\nThis cannot be undone.')) {
        FG().counts = [];
        FG().rolls.forEach(function (r) { r.measuredIn = null; r.measuredAt = null; r.measuredBy = null; });
        DB.save();
        good(); render();
      }
    };
    apply();
  }};
  function metric(num, label, cls) {
    return '<div class="metric ' + (cls || '') + '"><div class="n num">' + num + '</div><div class="l">' + label + '</div></div>';
  }
};

/* ---------------- CYCLE COUNT DISCREPANCIES (supervisor) ---------------------------
   Shows only rolls whose latest physically-measured balance differs from the
   expected balance. Discrepancies are recorded for review — reviewing never
   changes the expected balance; that only happens through cut transactions. */

/* ---- prototype lines 3000-3024 ---- */
Screens['count/review'] = function () {
  var rows = discrepancyRolls();
  var html =
    '<div class="screen">' +
    '<div class="step-head">SUPERVISOR</div>' +
    '<h1>Cycle count discrepancies</h1>' +
    '<p class="hint">Rolls where the last <b>measured</b> balance (MB ✓) differs from the expected balance. ' +
    'Review only &mdash; expected balances change through cut transactions, never here.</p>' +
    (rows.length ? rows.map(function (c) {
      return '<button class="rowbtn" data-count="' + esc(c.id) + '">' +
        '<div class="rhead"><b class="mono">' + esc(c.rollId) + '</b>' + statusChip(c.status) +
        ' <span class="stchip st-green">MB ✓</span></div>' +
        '<div class="sub">loc <b class="mono">' + esc(c.scannedLocation) + '</b> &middot; ' + esc(c.employee) + ' &middot; ' + esc(c.time || fmtTime(c.at)) + '</div>' +
        '<div class="sub num">Exp <b>' + fmtLen(c.expectedIn) + '</b> &middot; Meas <b>' + fmtLen(c.physicalIn) + '</b>' +
        ' &middot; Diff <b class="' + diffCls(c.diffIn) + '">' + fmtDiff(c.diffIn) + '</b></div></button>';
    }).join('') : '<p class="hint center">No discrepancies &mdash; every measured roll matches.</p>') +
    '</div>';
  return { html: html, mount: function () { wireCountRows(); } };
};

/* ---------------- boot ---------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', function () {
  DB.load();
  if (typeof Repository !== 'undefined') Repository.configure();
  render();
});

DB.load();
if (typeof Repository !== 'undefined') Repository.configure();
renderDrawer();
wireShell();
updateSyncIndicator();
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('hashchange', render);
  /* Shared mode: background refresh when returning to a page (debounced). */
  var _navRefreshT = null;
  window.addEventListener('hashchange', function () {
    if (dataMode() !== 'shared') return;
    if (_navRefreshT) clearTimeout(_navRefreshT);
    _navRefreshT = setTimeout(function () {
      Repository.refresh({ quiet: true }).catch(function () {});
    }, 900);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && dataMode() === 'shared') {
      Repository.refresh({ quiet: true }).catch(function () {});
    }
  });
}
render();
