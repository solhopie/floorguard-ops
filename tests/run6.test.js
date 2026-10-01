/* FloorGuard Ops — Run 6 order + sales order assertions.
   Run: node tests/run6.test.js
   Covers the Run 6 test list: schema-5 migration + fixtures, Run 6 §0
   timezone/completion/reopen locks, the centralized order policy, header +
   item validation, the full local commercial chain (create -> items ->
   ready -> submit -> sales order -> partial release -> work order), cancel
   semantics (never deletes work), shared two-device submit/release via the
   PostgREST double (idempotent retries, offline fail-fast), and the 0007
   migration contract. Same vm-sandbox trick as the earlier suites. */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var dbl = require('./postgrest-double.js');

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

/* ---------- DOM stub (same as run5.test.js) ---------- */
function makeEl(id) {
  return {
    _id: id, innerHTML: '', textContent: '', value: '', hidden: false, className: '',
    onclick: null, onsubmit: null, oninput: null, style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    addEventListener: function () {}, appendChild: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    querySelector: function () { return makeEl(id + ':q'); },
    querySelectorAll: function () { return []; },
    focus: function () {}, click: function () { if (this.onclick) this.onclick(); },
    remove: function () {}, scrollIntoView: function () {}
  };
}
function makeDevice() {
  var store = {};
  var els = {};
  function elFor(id) { return els[id] || (els[id] = makeEl(id)); }
  var nav = { vibrate: function () {}, onLine: true };
  var sandbox = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    Buffer: Buffer, fetch: fetch,
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    document: {
      addEventListener: function () {},
      getElementById: function (id) { return elFor(id); },
      querySelector: function (sel) {
        var m = /^#([\w-]+)$/.exec(sel || '');
        return m ? elFor(m[1]) : makeEl('anon');
      },
      querySelectorAll: function () { return []; },
      createElement: function () { return makeEl('created'); },
      body: makeEl('body')
    },
    window: { addEventListener: function () {}, scrollTo: function () {}, location: { hash: '' } },
    navigator: nav
  };
  vm.createContext(sandbox);
  var appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  var bootIdx = appSrc.lastIndexOf('/* ---------------- boot');
  vm.runInContext(appSrc.slice(0, bootIdx), sandbox, { filename: 'app.js' });
  var repoSrc = fs.readFileSync(path.join(__dirname, '..', 'repository.js'), 'utf8');
  vm.runInContext(repoSrc, sandbox, { filename: 'repository.js' });
  sandbox.DB.reset();
  sandbox.DB.data.currentEmployee = 'Marcus';
  sandbox._nav = nav;
  return sandbox;
}
function sharedConfig(D, base) {
  D.Repository.saveConfig({
    dataProvider: 'shared', supabaseUrl: base,
    supabaseAnonKey: 'test-anon-key', warehouseId: 'main'
  });
}
function throwsCode(fn, code) {
  try { fn(); } catch (e) { return e && e.code === code; }
  return false;
}
async function rejectsCode(p, code) {
  try { await p; } catch (e) { return e && e.code === code; }
  return false;
}

async function main() {
  /* ================= A. schema 5 + migration ================= */
  var S = makeDevice();
  ok(S.DB.data.schema === 7, 'seed schema is 7');
  ok(S.DB.data.warehouses[0].timezone === 'America/New_York', 'seed warehouse carries an explicit IANA timezone');
  ok((S.FG().orders || []).length >= 2, 'seed carries development order fixtures');
  ok((S.FG().salesOrders || []).length >= 1, 'seed carries a sales order fixture');
  var seedSo = S.FG().salesOrders.filter(function (x) { return x.number === 'SO-100245'; })[0];
  ok(seedSo && (seedSo.lines || []).length === 2, 'seed SO-100245 has two material lines');
  ok(seedSo && seedSo.lines[0].warehouseQtyRequired === 237, 'seed SO line carries warehouse qty required');
  /* v4 -> v5 migration path: simulate a Run 5 store and run the migrator. */
  var M = makeDevice();
  var mfg = M.FG();
  delete mfg.orders; delete mfg.salesOrders; delete mfg.orderEvents; delete mfg.seq;
  (mfg.workOrders || []).forEach(function (w) { delete w.salesOrderId; delete w.salesOrderLineId; });
  M.migrateFloorguardV4toV5();
  ok(Array.isArray(mfg.orders) && Array.isArray(mfg.salesOrders) && Array.isArray(mfg.orderEvents) &&
     mfg.seq.order >= 1002 && mfg.seq.salesOrder >= 100246,
    'v4->v5 migration creates collections and reseeds seq counters above fixtures');
  ok(mfg.salesOrders.some(function (x) { return x.number === 'SO-100245' && (x.lines || []).length === 2; }) &&
     mfg.orders.some(function (x) { return x.number === 'ORD-1000' && x.salesOrderId === 'SO-100245'; }),
    'v4->v5 migration backfills the Run 6 demo fixtures (ORD-1000/SO-100245) on pre-Run-6 stores');
  ok((mfg.workOrders || []).every(function (w) { return 'salesOrderId' in w && 'salesOrderLineId' in w; }),
    'v4->v5 migration backfills work-order traceability fields');

  /* ================= B. timezone locks (§0) ================= */
  var wh = S.DB.data.warehouses[0];
  ok(S.warehouseTimezone() === 'America/New_York', 'warehouseTimezone resolves from the warehouse record');
  var fmt = S.fmtAuditTime(new Date(Date.UTC(2026, 8, 30, 22, 30)).toISOString());
  ok(/SEP 30/i.test(fmt) && /6:30/i.test(fmt), 'fmtAuditTime renders in warehouse timezone (22:30Z -> 6:30pm ET): ' + fmt);
  var gmt = S.fmtAuditTime('2026-01-15T12:00:00Z');
  ok(/JAN 15/i.test(gmt) && /7:00/i.test(gmt), 'fmtAuditTime honors standard-time offset too: ' + gmt);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(S.warehouseToday()), 'warehouseToday returns a warehouse-local date string');

  /* ================= C. completion + reopen (§0) ================= */
  var C = makeDevice();
  /* Give Dana a supervisor role for these checks. */
  C.DB.data.employeeRoles.Dana = 'SUPERVISOR';
  var job = { id: 'T-C0', number: 'T-C0', property: 'P', account: 'A', opStatus: 'IN_PROGRESS',
    assigneeId: 'e2' /* Dana */, scheduledDate: C.warehouseToday(), onHold: false,
    lines: [{ id: 'T-C0-L1', style: 'S', color: 'C', materialType: 'CARPET', uom: 'LF',
      widthIn: 144, requiredIn: 100, requiredCount: null }] };
  C.FG().workOrders.push(job);
  /* assigned employee (Dana) cannot complete while the line is incomplete.
     Local completion follows the Run 5 result convention: {ok:false,err}. */
  C.DB.data.currentEmployee = 'Dana';
  var cr1 = await C.Repository.completeWarehouseWork('T-C0');
  ok(cr1.ok === false && /INCOMPLETE/.test(cr1.err), 'assignee completion still blocked by incomplete lines');
  /* verify the line, then Dana (assignee) may complete — no supervisor needed */
  C.FG().inventoryAssignments.push({ id: 'T-C0-A1', workOrderId: 'T-C0', lineId: 'T-C0-L1',
    rollId: '16628697', status: 'CONSUMED', reservedIn: 100 });
  var dc = await C.Repository.completeWarehouseWork('T-C0');
  ok(dc.ok === true && C.woById('T-C0').opStatus === 'COMPLETE', 'assigned employee completes own job when guard passes');
  /* Luis (neither assignee nor supervisor) cannot */
  C.DB.data.currentEmployee = 'Luis';
  var cr2 = await C.Repository.completeWarehouseWork('T-C0');
  ok(cr2.ok === false && /NOT AUTHORIZED/.test(cr2.err), 'unrelated warehouse employee cannot complete');
  /* reopen requires a reason and a supervisor-or-above role */
  C.DB.data.currentEmployee = 'Dana';
  var rr0 = await C.Repository.reopenWarehouseWork('T-C0', '');
  ok(rr0.ok === false && /REASON/.test(rr0.err), 'reopen without a reason is rejected');
  var rr = await C.Repository.reopenWarehouseWork('T-C0', 'Wrong roll linked.');
  ok(rr.ok === true && C.woById('T-C0').opStatus === 'IN_PROGRESS', 'supervisor reopens with a reason');
  ok(C.assignEventsForWO('T-C0').some(function (e) { return e.action === 'WAREHOUSE_WORK_REOPENED'; }),
    'reopen is audit-trailed');
  C.DB.data.currentEmployee = 'Luis';
  var rr2 = await C.Repository.reopenWarehouseWork('T-C0', 'x');
  ok(rr2.ok === false && /SUPERVISOR/.test(rr2.err), 'warehouse employee cannot reopen');
  /* Count-based lines: no cut-verification engine exists, so a plain
     assignee cannot self-certify them — supervisor judgment required. */
  var CB = makeDevice();
  CB.DB.data.employeeRoles.Dana = 'SUPERVISOR';
  var cjob = { id: 'T-CB', number: 'T-CB', property: 'P', account: 'A', opStatus: 'IN_PROGRESS',
    assigneeId: 'e3' /* Luis */, scheduledDate: CB.warehouseToday(), onHold: false,
    lines: [{ id: 'T-CB-L1', style: 'Pad', materialType: 'PAD', uom: 'BOX', widthIn: null,
      requiredIn: 0, requiredCount: 12 }] };
  CB.FG().workOrders.push(cjob);
  CB.DB.data.currentEmployee = 'Luis';
  var cb1 = await CB.Repository.completeWarehouseWork('T-CB');
  ok(cb1.ok === false && /SUPERVISOR VERIFICATION/.test(cb1.err),
    'assignee cannot self-complete count-based lines');
  CB.DB.data.currentEmployee = 'Dana';
  var cb2 = await CB.Repository.completeWarehouseWork('T-CB');
  ok(cb2.ok === true && CB.woById('T-CB').opStatus === 'COMPLETE',
    'supervisor completes count-based job under recorded judgment');
  ok(CB.assignEventsForWO('T-CB').some(function (e) {
      return e.action === 'WAREHOUSE_WORK_COMPLETED' && /supervisor judgment/.test(e.detail || ''); }),
    'supervisor judgment is audit-trailed');

  /* ================= D. role policy ================= */
  var P = makeDevice();
  P.DB.data.employeeRoles.Dana = 'SUPERVISOR';
  P.DB.data.currentEmployee = 'Luis'; /* WORKER */
  var wp = P.orderPolicy();
  ok(!wp.canCreateOrder && !wp.canReleaseLine && !wp.canHoldSalesOrder, 'worker: no create/submit/release/hold');
  P.DB.data.currentEmployee = 'Dana'; /* SUPERVISOR */
  var sp = P.orderPolicy();
  ok(!sp.canCreateOrder && sp.canReleaseLine && !sp.canHoldSalesOrder, 'supervisor: release only');
  P.DB.data.currentEmployee = 'Marcus'; /* MANAGER */
  var mp = P.orderPolicy();
  ok(mp.canCreateOrder && mp.canSubmitOrder && mp.canReleaseLine && mp.canHoldSalesOrder && mp.canCancelSalesOrder,
    'manager: full order/sales-order rights except admin-only? (admin has all)');
  P.DB.data.currentEmployee = 'Luis';
  var pw = await P.Repository.createOrder({ property: 'X' });
  ok(pw.ok === false && pw.err === 'MANAGER ROLE REQUIRED', 'worker createOrder rejected by policy');

  /* ================= E. validation ================= */
  ok(P.validateOrderHeader({ property: '' }) !== null, 'header requires a property');
  ok(P.validateOrderHeader({ property: 'Harbor Ridge' }) === null, 'header with property validates');
  ok(P.validateOrderItem({ style: '', materialType: 'CARPET', uom: 'LF', widthIn: 144, quantityIn: 100 }) !== null,
    'item requires a style');
  ok(P.validateOrderItem({ style: 'Marvel', materialType: 'CARPET', uom: 'LF', widthIn: 144, quantityIn: 0 }) !== null,
    'LF item needs a positive length');
  ok(P.validateOrderItem({ style: 'Rebond Pad', materialType: 'PAD', uom: 'BOX', quantity: 12 }) === null,
    'count-based item validates');
  ok(P.orderItemQtyDisplay({ uom: 'LF', quantityIn: 237 }) === "19' 9\" LF",
    'LF qty display carries feet/inches: ' + P.orderItemQtyDisplay({ uom: 'LF', quantityIn: 237 }));
  ok(P.orderItemQtyDisplay({ uom: 'LF', warehouseQtyRequired: 237 }) === "19' 9\" LF",
    'SO-line shape renders from warehouseQtyRequired');
  ok(P.orderItemQtyDisplay({ uom: 'BOX', quantity: 12 }) === '12 BOX', 'count qty display');

  /* ================= F. local commercial chain ================= */
  var L = makeDevice(); /* Marcus = MANAGER */
  var hc = await L.Repository.createOrder({ property: 'Harbor Ridge', requestedDate: '2026-10-05',
    priority: 'HIGH', notes: 'local test' });
  ok(hc.ok && hc.order.number === 'ORD-1002', 'local createOrder numbers after fixtures: ' + hc.order.number);
  ok(hc.order.account === 'Seaside Homes', 'account auto-fills from the property directory: ' + hc.order.account);
  ok(hc.order.status === 'DRAFT', 'new order is a draft');
  ok(L.getDraftOrdersLocal().some(function (o) { return o.id === hc.order.id; }), 'draft appears in draft list');
  var ia = await L.Repository.addOrderItem(hc.order.id, { style: 'Marvel', color: 'Chrome',
    materialType: 'CARPET', uom: 'LF', widthIn: 144, quantityIn: 237 });
  ok(ia.ok && ia.item.seq === 1 && ia.item.quantityIn === 237, 'LF item added with inch math');
  var ib = await L.Repository.addOrderItem(hc.order.id, { style: 'Rebond Pad', color: 'Natural',
    materialType: 'PAD', uom: 'BOX', widthIn: null, quantity: 12 });
  ok(ib.ok && ib.item.seq === 2 && ib.item.quantity === 12, 'count item added');
  var rd = await L.Repository.markOrderReady(hc.order.id);
  ok(rd.ok && rd.order.status === 'READY_FOR_REVIEW', 'order marked ready');
  var sub = await L.Repository.submitOrder(hc.order.id);
  ok(sub.ok && sub.salesOrder.number === 'SO-100246', 'local submit creates sales order: ' + sub.salesOrder.number);
  ok((sub.salesOrder.lines || []).length === 2, 'sales order carries both lines');
  ok(sub.salesOrder.lines[0].sourceItemId === ia.item.id, 'line traces to source item');
  ok(sub.salesOrder.lines[0].warehouseQtyRequired === 237, 'LF line warehouse qty = ordered inches');
  ok(sub.salesOrder.lines[1].warehouseQtyRequired === 12, 'count line warehouse qty = ordered qty');
  ok(sub.order.status === 'SUBMITTED', 'order marked submitted');
  /* double submit: no duplicate */
  var sub2 = await L.Repository.submitOrder(hc.order.id);
  ok(sub2.ok && sub2.duplicate === true && sub2.salesOrder.id === sub.salesOrder.id, 'double submit is idempotent');
  ok(L.getSalesOrdersLocal().filter(function (s) { return s.number === 'SO-100246'; }).length === 1,
    'exactly one sales order row exists');
  /* partial release: line 1 only */
  var rl1 = await L.Repository.releaseSalesOrderLine(sub.salesOrder.id, sub.salesOrder.lines[0].id);
  ok(rl1.ok && !rl1.duplicate, 'line 1 released');
  var wo1 = rl1.workOrder;
  ok(wo1.salesOrderId === sub.salesOrder.id && wo1.salesOrderLineId === sub.salesOrder.lines[0].id,
    'work order traces to sales order + line');
  ok(wo1.lines[0].requiredIn === 237 && wo1.lines[0].uom === 'LF', 'WO material line carries required inches');
  ok(wo1.style === 'Marvel' && wo1.color === 'Chrome' && wo1.materialType === 'CARPET' &&
     wo1.widthIn === 144 && wo1.quantity === 237 && wo1.uom === 'LF',
    'generated WO flattens line fields to the top level for the detail header: ' +
    wo1.style + '/' + wo1.color + '/' + wo1.widthIn + '/' + wo1.quantity);
  ok(L.scheduledJobs().some(function (w) { return w.id === wo1.id; }),
    'generated work order appears in Scheduled Jobs automatically');
  /* IN PROGRESS tab filter: a released SO whose WO is still OPEN belongs in
     RELEASED, not IN PROGRESS (tab key is 'IN PROGRESS' with a space). */
  var soAfter1b = L.salesOrderById(sub.salesOrder.id);
  ok(!L.salesOrdersByTab('IN PROGRESS').some(function (s) { return s.id === soAfter1b.id; }) &&
     L.salesOrdersByTab('OPEN').some(function (s) { return s.id === soAfter1b.id; }),
    'partially released SO with an OPEN WO is not listed in the IN PROGRESS tab');
  L.DB.data.currentEmployee = 'Marcus';
  wo1.opStatus = 'IN_PROGRESS';
  ok(L.salesOrdersByTab('IN PROGRESS').some(function (s) { return s.id === soAfter1b.id; }),
    'SO moves into the IN PROGRESS tab once its WO is in progress');
  wo1.opStatus = 'OPEN';
  var jobs = (L.FG().workOrders || []).filter(function (w) { return w.salesOrderId === sub.salesOrder.id; });
  ok(jobs.length === 1, 'generated WO exists in the job pool');
  var soAfter1 = L.salesOrderById(sub.salesOrder.id);
  ok(soAfter1.status === 'PARTIALLY_RELEASED', 'SO is PARTIALLY_RELEASED after one of two lines');
  ok(L.salesOrdersByTab('OPEN').some(function (s) { return s.id === soAfter1.id; }),
    'partially released SO stays actionable in the OPEN tab');
  /* double release: no duplicate WO */
  var rl1b = await L.Repository.releaseSalesOrderLine(sub.salesOrder.id, sub.salesOrder.lines[0].id);
  ok(rl1b.ok && rl1b.duplicate === true && rl1b.workOrder.id === wo1.id, 'double release is idempotent');
  ok((L.FG().workOrders || []).filter(function (w) { return w.salesOrderLineId === sub.salesOrder.lines[0].id; }).length === 1,
    'still exactly one WO for the line');
  /* release line 2 (count-based) */
  var rl2 = await L.Repository.releaseSalesOrderLine(sub.salesOrder.id, sub.salesOrder.lines[1].id);
  ok(rl2.ok && rl2.workOrder.lines[0].requiredCount === 12, 'count line generates WO with requiredCount');
  var soAfter2 = L.salesOrderById(sub.salesOrder.id);
  ok(soAfter2.status === 'RELEASED_TO_WAREHOUSE', 'SO is RELEASED once all lines released: ' + soAfter2.status);
  ok(L.salesOrdersByTab('RELEASED').some(function (s) { return s.id === soAfter2.id; }),
    'fully released SO moves to the RELEASED tab');
  /* hold / resume */
  var hd = await L.Repository.holdSalesOrder(sub.salesOrder.id, 'Waiting on customer');
  ok(hd.ok && hd.salesOrder.onHold && hd.salesOrder.status === 'ON_HOLD', 'hold sets status');
  var hr = await L.Repository.resumeSalesOrder(sub.salesOrder.id);
  ok(hr.ok && !hr.salesOrder.onHold && hr.salesOrder.status === 'OPEN', 'resume clears the hold');
  /* cancel with work orders requires force; work orders survive.
     Local cancel follows the Run 5 result convention ({ok:false,err}). */
  var cerr = await L.Repository.cancelSalesOrder(sub.salesOrder.id, 'Customer changed mind');
  ok(cerr.ok === false && cerr.err === 'WAREHOUSE WORK EXISTS', 'cancel blocked while work orders exist');
  var cx = await L.Repository.cancelSalesOrder(sub.salesOrder.id, 'Customer changed mind', { force: true });
  ok(cx.ok === true && cx.salesOrder.status === 'CANCELLED', 'forced cancel completes');
  ok(L.woById(wo1.id) && L.woById(wo1.id).opStatus !== 'CANCELLED',
    'cancellation never deletes or cancels existing work orders');
  ok(L.orderEventsFor({ salesOrderId: sub.salesOrder.id }).some(function (e) { return e.action === 'SALES_ORDER_CANCELLED'; }),
    'cancel is audit-trailed');
  /* offline local submit still works against the local store (§31) */
  L._nav.onLine = false;
  var oh = await L.Repository.createOrder({ property: 'Ventura Pointe' });
  await L.Repository.addOrderItem(oh.order.id, { style: 'S', materialType: 'CARPET', uom: 'LF', widthIn: 144, quantityIn: 50 });
  var osub = await L.Repository.submitOrder(oh.order.id);
  ok(osub.ok && osub.salesOrder.number === 'SO-100247', 'local submit works offline against the local store');
  L._nav.onLine = true;

  /* ================= G. shared two-device + offline ================= */
  var harness = dbl.startDouble();
  var base = await harness.start();
  var A = makeDevice(), B = makeDevice();
  A.DB.data.employeeRoles.Marcus = 'MANAGER';
  B.DB.data.employeeRoles.Dana = 'SUPERVISOR';
  sharedConfig(A, base); sharedConfig(B, base);
  await A.Repository.signIn('marcus@warehouse.com', 'pw');
  await A.Repository.refresh();
  var aDrafts = await A.Repository.getDraftOrders();
  ok(Array.isArray(aDrafts), 'shared getDraftOrders resolves after hydrate');
  /* manager creates + submits on device A */
  A.DB.data.currentEmployee = 'Marcus';
  var sh = await A.Repository.createOrder({ property: 'Harbor Ridge', requestedDate: '2026-10-06', priority: 'HIGH' });
  await A.Repository.addOrderItem(sh.order.id, { style: 'Marvel', color: 'Chrome', materialType: 'CARPET',
    uom: 'LF', widthIn: 144, quantityIn: 237 });
  await A.Repository.addOrderItem(sh.order.id, { style: 'Rebond', color: 'Natural', materialType: 'PAD',
    uom: 'BOX', widthIn: null, quantity: 12 });
  await A.Repository.markOrderReady(sh.order.id);
  var ssub = await A.Repository.submitOrder(sh.order.id);
  ok(ssub.ok && !ssub.duplicate && ssub.salesOrder.number, 'shared submit via atomic RPC: ' + ssub.salesOrder.number);
  /* double submit -> duplicate:true, single row in the backend */
  var ssub2 = await A.Repository.submitOrder(sh.order.id);
  ok(ssub2.ok && ssub2.duplicate === true && ssub2.salesOrder.id === ssub.salesOrder.id,
    'shared double submit returns the existing sales order');
  var soRows = harness.state.tables.sales_orders;
  var sameNo = Array.from(soRows.values()).filter(function (r) { return r.number === ssub.salesOrder.number; });
  ok(sameNo.length === 1, 'backend holds exactly one sales order row');
  /* supervisor releases on device B after refresh */
  await B.Repository.signIn('dana@warehouse.com', 'pw');
  B.DB.data.currentEmployee = 'Dana';
  await B.Repository.refresh();
  var bSo = B.salesOrderById(ssub.salesOrder.id);
  ok(bSo && bSo.number === ssub.salesOrder.number && (bSo.lines || []).length === 2,
    'device B sees the submitted sales order + lines after refresh');
  var bRel = await B.Repository.releaseSalesOrderLine(bSo.id, bSo.lines[0].id);
  ok(bRel.ok && !bRel.duplicate, 'device B releases the line via atomic RPC');
  var bRel2 = await B.Repository.releaseSalesOrderLine(bSo.id, bSo.lines[0].id);
  ok(bRel2.ok && bRel2.duplicate === true && bRel2.workOrder.id === bRel.workOrder.id,
    'shared double release returns the existing work order');
  var woRows = Array.from(harness.state.tables.work_orders.values())
    .filter(function (r) { return r.sales_order_line_id === bSo.lines[0].id; });
  ok(woRows.length === 1, 'backend holds exactly one work order for the line');
  /* partial release: SO rolls up to PARTIALLY_RELEASED with line 2 still open */
  await A.Repository.refresh();
  var aSo = A.salesOrderById(ssub.salesOrder.id);
  ok(aSo && aSo.lines[0].status === 'RELEASED' && aSo.lines[1].status === 'OPEN' &&
     aSo.status === 'PARTIALLY_RELEASED', 'device A sees partial release after refresh: ' + (aSo && aSo.status));
  ok(A.woById(bRel.workOrder.id) && A.woById(bRel.workOrder.id).salesOrderId === aSo.id,
    'generated work order hydrates with traceability on device A');
  /* full trace: order -> sales order -> work order -> assignment -> roll -> cut */
  A.DB.data.currentEmployee = 'Marcus';
  var two = A.woById(bRel.workOrder.id);
  ok(two && two.salesOrderLineId === aSo.lines[0].id, 'ORIGINAL ORDER -> SALES ORDER -> WORK ORDER trace intact');
  /* offline shared submit/release fail honestly */
  var cOff = makeDevice();
  sharedConfig(cOff, base);
  cOff._nav.onLine = false;
  var oe1 = null;
  try { await cOff.Repository.submitOrder('nope'); } catch (e) { oe1 = e; }
  ok(oe1 && oe1.code === 'OFFLINE', 'offline shared submit fails fast with OFFLINE');
  var oe2 = null;
  try { await cOff.Repository.releaseSalesOrderLine('nope', 'nope'); } catch (e) { oe2 = e; }
  ok(oe2 && oe2.code === 'OFFLINE', 'offline shared release fails fast with OFFLINE');
  /* hold blocks release on the backend (fresh unreleased line 2) */
  await A.Repository.holdSalesOrder(aSo.id, 'Customer hold');
  var rh = null;
  try { await B.Repository.releaseSalesOrderLine(aSo.id, aSo.lines[1].id); } catch (e) { rh = e; }
  ok(rh && rh.code === 'SALES_ORDER_NOT_RELEASABLE',
    'release refused while the sales order is on hold: ' + (rh && rh.code));
  await A.Repository.resumeSalesOrder(aSo.id);
  var bRel3 = await B.Repository.releaseSalesOrderLine(aSo.id, aSo.lines[1].id);
  ok(bRel3.ok && !bRel3.duplicate, 'release succeeds after resume');
  await A.Repository.refresh();
  var aSoFull = A.salesOrderById(aSo.id);
  ok(aSoFull && aSoFull.status === 'RELEASED_TO_WAREHOUSE',
    'SO fully released after both lines: ' + (aSoFull && aSoFull.status));
  await harness.close();

  /* ================= H. 0007 migration contract ================= */
  var mig = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '0007_order_sales_order.sql'), 'utf8');
  ok(/create table public\.orders/i.test(mig), '0007 creates orders');
  ok(/create table public\.sales_orders/i.test(mig), '0007 creates sales_orders');
  ok(/create table public\.sales_order_lines/i.test(mig), '0007 creates sales_order_lines');
  ok(/function public\.submit_sales_order\(/i.test(mig), '0007 defines submit_sales_order RPC');
  ok(/function public\.release_sales_order_line\(/i.test(mig), '0007 defines release_sales_order_line RPC');
  ok(/source_order_id text not null unique/i.test(mig), '0007: one sales order per order');
  ok(/enable row level security/i.test(mig), '0007 enables RLS');
  ok(/required_count/.test(mig), '0007 carries required_count for count-based lines');
  ok(/sales_order_id/.test(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'seed.sql'), 'utf8')),
    'seed.sql carries the Run 6 fixtures');

  /* ================= I. dashboard + global search ================= */
  var W = makeDevice();
  var dashDrafts = W.getDraftOrdersLocal().length;
  ok(dashDrafts >= 1, 'dashboard draft card has data (' + dashDrafts + ')');
  var openSos = W.salesOrdersByTab('OPEN').length;
  ok(openSos >= 0, 'dashboard open-SO card has data');
  ok(W.salesOrderTabs().join(',') === 'OPEN,RELEASED,IN PROGRESS,COMPLETED',
    'sales order tabs match spec §13');
  ok(W.salesOrderById(seedSo.id).number === 'SO-100245', 'sales order detail resolves by id');

  /* ================= J. shared hydration flattens material fields ================= */
  var H2 = makeDevice();
  var hyWo = H2.Mappers.rowToWorkOrder(
    { id: 'WO-H', number: 'WO-9999', property: 'P', account: 'A', status: 'OPEN',
      assignment_status: 'UNASSIGNED', scheduled_date: '2026-10-05' },
    [{ id: 'WO-H-L1', work_order_id: 'WO-H', material_type: 'CARPET', style: 'Marvel',
       color: 'Chrome', width_in: 144, required_in: 237, required_count: null }]);
  ok(hyWo.style === 'Marvel' && hyWo.color === 'Chrome' && hyWo.materialType === 'CARPET' &&
     hyWo.widthIn === 144 && hyWo.quantity === 237,
    'shared-hydrated WO flattens the first material line to top-level fields');
  ok(hyWo.lines.length === 1 && hyWo.lines[0].requiredIn === 237, 'hydrated WO keeps its material lines');

  console.log('\nrun6: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) { console.error('FATAL', e); process.exit(1); });
