/* FloorGuard Ops — Run 7 loadout + receipts + central numbering assertions.
   Run: node tests/run7.test.js
   Covers: schema-6 migration, local simulated central numbering
   (idempotent + collision-safe), local receipt flows (expected/manual,
   duplicate-roll guard + supervisor override, immediate inventory
   visibility, completion), local loadout flows (readiness gate, wrong
   material rejection, mark-loaded without balance changes, completion
   guard), shared two-device flows through the PostgREST double
   (backend-issued ORD/SO/WO/RCV/LOAD numbers, idempotent retries,
   concurrent issuance uniqueness, multi-device sync, offline fail-fast),
   and role gating for warehouse/supervisor.
   Same vm-sandbox trick as the earlier suites. */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var dbl = require('./postgrest-double.js');

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}
function makeEl(id) {
  return {
    _id: id, innerHTML: '', textContent: '', value: '', hidden: false, className: '',
    onclick: null, onsubmit: null, oninput: null, style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    addEventListener: function () {}, appendChild: function () {}, setAttribute: function () {},
    getAttribute: function () { return null; },
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
async function rejectsCode(p, code) {
  try { await p; } catch (e) { return e && e.code === code; }
  return false;
}

async function main() {
  /* ================= A. schema 6 + migration ================= */
  var S = makeDevice();
  ok(S.DB.data.schema === 7, 'seed schema is 7');
  ok(Array.isArray(S.FG().loadouts) && Array.isArray(S.FG().receipts) &&
     Array.isArray(S.FG().loadoutEvents) && Array.isArray(S.FG().receiptEvents),
    'seed carries loadout + receipt collections');
  ok(S.FG().seq.receipt >= 100001 && S.FG().seq.loadout >= 100001,
    'seed seeds receipt/loadout counters at 100001');
  /* v5 -> v6 migration path */
  var M = makeDevice();
  var mfg = M.FG();
  delete mfg.loadouts; delete mfg.receipts; delete mfg.loadoutEvents; delete mfg.receiptEvents;
  mfg.seq.receipt = 0; mfg.seq.loadout = 0;
  M.migrateFloorguardV5toV6();
  ok(Array.isArray(mfg.loadouts) && Array.isArray(mfg.receipts) &&
     mfg.seq.receipt >= 100001 && mfg.seq.loadout >= 100001,
    'v5->v6 migration creates collections and reseeds counters above fixtures');

  /* ================= B. local numbering: idempotent + collision-safe ================= */
  var N = makeDevice();
  var n1 = await N.Repository.issueBusinessNumber('ORD', 'run7-k1');
  var n1r = await N.Repository.issueBusinessNumber('ORD', 'run7-k1');
  var n2 = await N.Repository.issueBusinessNumber('ORD', 'run7-k2');
  ok(/^ORD-\d+$/.test(n1) && n1r === n1, 'local ORD number issued, retry with same key returns the same number');
  ok(n2 !== n1, 'a different request key advances the counter (no reuse): ' + n1 + ' vs ' + n2);
  var r1 = await N.Repository.issueBusinessNumber('RCV', 'run7-r1');
  var l1 = await N.Repository.issueBusinessNumber('LOAD', 'run7-l1');
  var s1 = await N.Repository.issueBusinessNumber('SO', 'run7-s1');
  var w1 = await N.Repository.issueBusinessNumber('WO', 'run7-w1');
  /* Local Demo simulates numbering; bases continue past the local
     fixtures (ORD-1000/1001, SO-100245, WO-1001..1004), fresh kinds at 100001. */
  ok(/^RCV-100001/.test(r1) && /^LOAD-100001/.test(l1) &&
     /^SO-100246/.test(s1) && /^WO-2001/.test(w1),
    'all five kinds issue from their documented bases: ' + [r1, l1, s1, w1].join(' '));

  /* ================= C. local receipt flows ================= */
  var R = makeDevice();
  R.DB.data.currentEmployee = 'Luis'; /* warehouse employee does normal receiving */
  var rc = await R.Repository.createReceipt({ supplier: 'Shaw', referenceNumber: 'PO-77', expected: true });
  ok(rc.ok && /^RCV-/.test(rc.receipt.number) && rc.receipt.status === 'EXPECTED',
    'expected receipt created with central number: ' + rc.receipt.number);
  /* manual non-scanned line: received quantity entered by hand */
  var ln = await R.Repository.addReceiptLine(rc.receipt.id, { materialType: 'PAD', uom: 'BOX',
    style: 'Rebond', color: 'Natural', receivedQty: 5 });
  ok(ln.ok && ln.receipt.lines.length === 1 && ln.receipt.lines[0].status === 'RECEIVED' &&
     ln.receipt.lines[0].receivedQty === 5,
    'manual received line added (PAD, qty 5)');
  var recv = await R.Repository.receiveRoll(rc.receipt.id, { barcode: 'NEWROLL1', style: 'Marvel',
    color: 'Chrome', manufacturer: 'Shaw', widthIn: 144, lengthIn: 600, location: '205B' });
  ok(recv.ok && !recv.duplicate && recv.roll.id === 'NEWROLL1' && recv.roll.beginningIn === 600,
    'roll received: atomic roll creation + initial balance');
  ok(R.rollById('NEWROLL1') && R.systemBalance('NEWROLL1') === 600,
    'inventory is immediately visible on the roll after receiving');
  ok(recv.receipt.lines.some(function (l) { return l.status === 'RECEIVED' && l.rollId === 'NEWROLL1'; }),
    'receipt line is RECEIVED and linked to the roll');
  var led = R.receiptEventsFor(rc.receipt.id);
  ok(led.some(function (e) { return e.action === 'ROLL_RECEIVED' && e.rollId === 'NEWROLL1'; }),
    'receipt activity carries the ROLL RECEIVED event');
  /* duplicate barcode: hard ROLL ALREADY EXISTS for the warehouse employee */
  var dup1 = await R.Repository.receiveRoll(rc.receipt.id, { barcode: 'NEWROLL1', style: 'Marvel',
    color: 'Chrome', widthIn: 144, lengthIn: 100, location: '205B' });
  ok(dup1.ok === false && dup1.err === 'ROLL ALREADY EXISTS' && dup1.needsSupervisor === true,
    'duplicate barcode returns explicit ROLL ALREADY EXISTS and asks for a supervisor');
  /* supervisor acknowledges: no new roll, no balance touch, exception recorded */
  R.DB.data.employeeRoles.Dana = 'SUPERVISOR';
  R.DB.data.currentEmployee = 'Dana';
  var rollCountBefore = R.FG().rolls.length;
  var dup2 = await R.Repository.receiveRoll(rc.receipt.id, { barcode: 'NEWROLL1', style: 'Marvel',
    color: 'Chrome', widthIn: 144, lengthIn: 100, location: '205B', supervisorOverride: true });
  ok(dup2.ok && dup2.duplicateRoll === true && R.FG().rolls.length === rollCountBefore,
    'supervisor duplicate acknowledgment creates no roll');
  ok(R.systemBalance('NEWROLL1') === 600, 'duplicate acknowledgment does not touch the existing roll balance');
  ok(R.receiptById(rc.receipt.id).exceptions.some(function (e) { return e.type === 'DUPLICATE ROLL'; }),
    'DUPLICATE ROLL exception recorded on the receipt');
  /* exception + completion */
  var ex = await R.Repository.createReceiptException(rc.receipt.id, 'DAMAGED', 'Corner crushed.');
  ok(ex.ok && R.receiptById(rc.receipt.id).status === 'EXCEPTIONS', 'exception moves the receipt to EXCEPTIONS');
  var done = await R.Repository.completeReceipt(rc.receipt.id);
  ok(done.ok && R.receiptById(rc.receipt.id).status === 'RECEIVED' &&
     R.receiptById(rc.receipt.id).completedBy === 'Dana', 'receipt completes with lines + exceptions recorded');

  /* ================= D. local loadout flows ================= */
  var L = makeDevice();
  L.DB.data.currentEmployee = 'Luis';
  L.FG().workOrders.push({ id: 'LO-WO1', number: 'WO-9001', property: 'P', account: 'A',
    opStatus: 'OPEN', priority: 'HIGH',
    lines: [{ id: 'LO-WO1-L1', style: 'Marvel', color: 'Chrome', materialType: 'CARPET',
      uom: 'LF', widthIn: 144, requiredIn: 237, requiredCount: null }] });
  L.FG().rolls.push({ id: 'LOROLL1', barcode: 'LOROLL1', style: 'Marvel', color: 'Chrome',
    materialType: 'carpet', widthIn: 144, beginningIn: 500, expectedIn: 500,
    expectedLocation: '205B', version: 1, warehouseId: 'main', discovered: false });
  /* not ready yet: nothing consumed */
  var nr = await L.Repository.startLoadout('LO-WO1');
  ok(nr.ok === false && /NOT READY/.test(nr.err), 'loadout start blocked until the cut is consumed');
  /* consume the assignment, then the WO is ready */
  L.FG().inventoryAssignments.push({ id: 'LO-A1', workOrderId: 'LO-WO1', lineId: 'LO-WO1-L1',
    rollId: 'LOROLL1', status: 'CONSUMED', reservedIn: 237, actualCutIn: 237,
    employee: 'Luis', warehouseId: 'main' });
  var st = await L.Repository.startLoadout('LO-WO1');
  ok(st.ok && !st.duplicate && /^LOAD-/.test(st.loadout.number) && st.loadout.status === 'READY',
    'loadout started with central number: ' + st.loadout.number);
  ok(st.loadout.lines.length === 1 && st.loadout.lines[0].status === 'WAITING' &&
     st.loadout.lines[0].preparedIn === 237, 'loadout line carries readiness (prepared 237in)');
  /* duplicate start returns the open loadout, never a second one */
  var st2 = await L.Repository.startLoadout('LO-WO1');
  ok(st2.ok && st2.duplicate === true && st2.loadout.id === st.loadout.id &&
     L.FG().loadouts.length === 1, 'duplicate start returns the open loadout (no second loadout)');
  var lid = st.loadout.id, llid = st.loadout.lines[0].id;
  /* completion guard: nothing loaded yet */
  var cg = await L.Repository.completeLoadout(lid);
  ok(cg.ok === false && /NOT ALL LINES|not all lines|INCOMPLETE/i.test(cg.err),
    'completion guard rejects a loadout with unloaded lines');
  var bg = await L.Repository.beginLoading(lid);
  ok(bg.ok && L.loadoutById(lid).status === 'IN_PROGRESS', 'begin loading -> IN_PROGRESS');
  /* wrong material: exception, line NOT accepted */
  L.FG().rolls.push({ id: 'WRONG1', barcode: 'WRONG1', style: 'Other', color: 'Blue',
    materialType: 'carpet', widthIn: 144, beginningIn: 300, expectedIn: 300,
    expectedLocation: '206B', version: 1, warehouseId: 'main', discovered: false });
  var balBefore = L.systemBalance('LOROLL1');
  var vw = await L.Repository.verifyLoadoutLine(lid, llid, 'WRONG1');
  ok(vw.ok === false && vw.err === 'WRONG MATERIAL' &&
     L.loadoutById(lid).lines[0].status === 'EXCEPTION',
    'wrong material is rejected and flagged, never accepted');
  ok(L.loadoutById(lid).exceptions.some(function (e) { return e.type === 'WRONG MATERIAL'; }),
    'WRONG MATERIAL exception recorded');
  /* right barcode: verify, then load; balances never move */
  var vv = await L.Repository.verifyLoadoutLine(lid, llid, 'LOROLL1');
  ok(vv.ok && L.loadoutById(lid).lines[0].status === 'VERIFIED', 'correct barcode verifies the line');
  var mk = await L.Repository.markLoadoutLineLoaded(lid, llid);
  ok(mk.ok && L.loadoutById(lid).lines[0].status === 'LOADED', 'verified line marked LOADED');
  ok(L.systemBalance('LOROLL1') === balBefore, 'marking loaded does not change the roll balance');
  ok(L.loadoutById(lid).status === 'LOADED', 'loadout reaches LOADED when every line is loaded');
  var fin = await L.Repository.completeLoadout(lid);
  ok(fin.ok && L.loadoutById(lid).status === 'COMPLETED' &&
     L.loadoutById(lid).completedBy === 'Luis', 'loadout completes');
  var woEv = L.orderEventsFor({ workOrderId: 'LO-WO1' });
  ok(woEv.some(function (e) { return e.action === 'LOADOUT_STARTED'; }) &&
     woEv.some(function (e) { return e.action === 'LOADOUT_COMPLETED'; }),
    'loadout start + completion ride the WO activity feed');
  /* role gating: a stranger with no employee identity cannot start a loadout */
  L.DB.data.currentEmployee = '';
  var ng = await L.Repository.startLoadout('LO-WO1');
  ok(ng.ok === false && /NOT AUTHORIZED/.test(ng.err), 'unsigned operator cannot start a loadout');

  /* ================= E. shared backend flows (two devices) ================= */
  var harness = dbl.startDouble();
  var base = await harness.start();
  var A = makeDevice(), B = makeDevice();
  A.DB.data.employeeRoles.Marcus = 'MANAGER';
  B.DB.data.employeeRoles.Dana = 'SUPERVISOR';
  sharedConfig(A, base); sharedConfig(B, base);
  await A.Repository.signIn('marcus@warehouse.com', 'pw');
  await B.Repository.signIn('dana@warehouse.com', 'pw');
  await A.Repository.refresh();

  /* E1. backend-issued ORD number on create */
  A.DB.data.currentEmployee = 'Marcus';
  var sh = await A.Repository.createOrder({ property: 'Harbor Ridge', requestedDate: '2026-10-06' });
  ok(sh.ok && /^ORD-\d+$/.test(sh.order.number), 'shared create issues a backend ORD number: ' + sh.order.number);
  /* E2. atomic create_order: retry with the same order id returns the
     existing order + number, no duplicate row, no burned number */
  var shR = await A.SharedRepo._rpc('create_order', { p_order_id: sh.order.id,
    p_warehouse_id: 'main', p_property: 'Harbor Ridge', p_account: null,
    p_requested_date: '2026-10-06', p_scheduled_date: null, p_priority: 'NORMAL',
    p_created_by: 'Marcus', p_internal_ref: null, p_notes: null })
    .then(A.SharedRepo._rpcResult);
  ok(shR.duplicate && shR.number === sh.order.number,
    'create_order retry is idempotent: same order, same number');
  /* E3. concurrent issuance through the real RPC path: 10 parallel receipt
     creates -> 10 unique RCV numbers */
  var conc = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (i) {
    return A.Repository.createReceipt({ supplier: 'Conc', expected: true,
      clientRequestId: 'conc-rcv-' + i });
  }));
  var uniq = {};
  conc.forEach(function (r) { uniq[r.receipt.number] = true; });
  ok(Object.keys(uniq).length === 10, 'concurrent receipt creation returns 10 unique numbers: ' +
    conc.slice(0, 3).map(function (r) { return r.receipt.number; }).join(',') + '...');
  /* E4. receipt + roll receiving on device A, visible on device B */
  A.DB.data.currentEmployee = 'Luis';
  var src = await A.Repository.createReceipt({ supplier: 'Shaw', expected: true });
  ok(src.ok && /^RCV-/.test(src.receipt.number), 'shared receipt gets a backend RCV number: ' + src.receipt.number);
  var crq = 'rcv-' + src.receipt.id + '-1';
  var sr1 = await A.Repository.receiveRoll(src.receipt.id, { barcode: 'SHAREDROLL1', style: 'Marvel',
    color: 'Chrome', widthIn: 144, lengthIn: 720, location: '205B', clientRequestId: crq });
  ok(sr1.ok && !sr1.duplicate && sr1.roll.sharedExpectedIn === 720, 'shared roll received atomically');
  /* retry with the same request key -> duplicate, exactly one line */
  var sr2 = await A.Repository.receiveRoll(src.receipt.id, { barcode: 'SHAREDROLL1', style: 'Marvel',
    color: 'Chrome', widthIn: 144, lengthIn: 720, location: '205B', clientRequestId: crq });
  ok(sr2.ok && sr2.duplicate === true, 'retried receive is idempotent (duplicate:true)');
  var rcRows = Array.from(harness.state.tables.receipt_lines.values())
    .filter(function (l) { return l.receipt_id === src.receipt.id; });
  ok(rcRows.length === 1, 'retry created no second receipt line');
  /* device B sees the receipt + roll after a refresh */
  await B.Repository.refresh();
  var bRoll = B.rollById('SHAREDROLL1');
  ok(bRoll && bRoll.sharedExpectedIn === 720, 'device B sees the received roll after refresh (multi-device sync)');
  ok(B.receiptById(src.receipt.id), 'device B sees the receipt after refresh');
  /* duplicate barcode on the backend: explicit ROLL ALREADY EXISTS */
  await rejectsCode(A.Repository.receiveRoll(src.receipt.id, { barcode: 'SHAREDROLL1', style: 'Marvel',
    color: 'Chrome', widthIn: 144, lengthIn: 50, location: '205B' }), 'ROLL_ALREADY_EXISTS')
    ? ok(true, 'backend duplicate barcode raises ROLL ALREADY EXISTS')
    : ok(false, 'backend duplicate barcode raises ROLL ALREADY EXISTS');

  /* E5. shared loadout: reserve -> cut -> start -> verify -> load -> complete */
  var asg = await A.Repository.assignInventory({ workOrderId: 'XS024536', lineId: 'XS024536-L1',
    rollId: '16628697', reservedIn: 237, employee: 'Luis' });
  ok(asg.ok, 'shared reserve for loadout WO');
  var cut = await A.Repository.recordCut({ rollId: '16628697', order: 'XS024536',
    cutIn: 237, employee: 'Luis', assignmentId: asg.assignmentId });
  ok(cut.ok && cut.newBalanceIn === 797, 'shared cut consumes the assignment (1034 -> 797)');
  var slo = await A.Repository.startLoadout('XS024536');
  ok(slo.ok && /^LOAD-/.test(slo.loadout.number), 'shared loadout started with backend number: ' + slo.loadout.number);
  var sll = slo.loadout.lines[0];
  ok(sll.barcode === '16628697' && sll.preparedIn === 237, 'shared loadout line carries the cut roll + prepared length');
  /* wrong material is rejected by the backend too */
  var wrc = await rejectsCode(A.Repository.verifyLoadoutLine(slo.loadout.id, sll.id, '16628698'),
    'WRONG MATERIAL');
  ok(wrc, 'backend rejects the wrong material');
  var svc = await A.Repository.verifyLoadoutLine(slo.loadout.id, sll.id, '16628697');
  ok(svc.ok, 'backend accepts the correct barcode');
  var sml = await A.Repository.markLoadoutLineLoaded(slo.loadout.id, sll.id);
  ok(sml.ok, 'backend marks the line loaded');
  await A.Repository.refresh();
  ok(A.systemBalance('16628697') === 797, 'loading does not move the roll balance on the backend either');
  var sfin = await A.Repository.completeLoadout(slo.loadout.id);
  ok(sfin.ok && A.loadoutById(slo.loadout.id).status === 'COMPLETED',
    'shared loadout completes');
  /* device B sees the completed loadout */
  await B.Repository.refresh();
  ok(B.loadoutById(slo.loadout.id) && B.loadoutById(slo.loadout.id).status === 'COMPLETED',
    'device B sees the completed loadout after refresh');

  /* E6. offline fail-fast: the shared mutations throw synchronously (never queued) */
  A._nav.onLine = false;
  var oe1 = null;
  try { await A.Repository.receiveRoll(src.receipt.id, { barcode: 'OFF1', style: 'S',
    widthIn: 144, lengthIn: 10 }); } catch (e) { oe1 = e; }
  ok(oe1 && oe1.code === 'OFFLINE', 'offline roll receive fails fast (OFFLINE — ROLL NOT RECEIVED)');
  var oe2 = null;
  try { await A.Repository.startLoadout('XS024536'); } catch (e) { oe2 = e; }
  ok(oe2 && oe2.code === 'OFFLINE', 'offline loadout start fails fast');
  var oe3 = null;
  try { await A.Repository.issueBusinessNumber('RCV', 'offline-k'); } catch (e) { oe3 = e; }
  ok(oe3 && oe3.code === 'OFFLINE', 'offline number issuance fails fast');
  A._nav.onLine = true;

  /* E7. receipt document linkage: local + shared */
  var tinyImg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  var ldoc = await N.Repository.uploadReceiptDocument({ receiptId: rc.receipt.id,
    imageDataUrl: tinyImg, thumbDataUrl: tinyImg, employee: 'Marcus' });
  ok(ldoc.ok && ldoc.doc.receiptId === rc.receipt.id && ldoc.doc.kind === 'RECEIPT_DOCUMENT',
    'local receipt document links receiptId');
  ok((await N.Repository.getDocumentsForReceipt(rc.receipt.id)).length >= 1,
    'local getDocumentsForReceipt returns the captured document');
  var sdoc = await A.Repository.uploadReceiptDocument({ receiptId: src.receipt.id,
    imageDataUrl: tinyImg, employee: 'Luis' });
  ok(sdoc.ok && sdoc.doc.receiptId === src.receipt.id,
    'shared receipt document uploads through the repository');
  await B.Repository.refresh();
  var bdocs = await B.Repository.getDocumentsForReceipt(src.receipt.id);
  ok(bdocs.length >= 1 && bdocs[0].receiptId === src.receipt.id,
    'shared receipt document is visible on the second device');

  await harness.close();
  console.log('run7: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch(function (e) { console.error('HARNESS ERROR', e); process.exit(1); });
