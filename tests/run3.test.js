/* FloorGuard Ops — Run 3 inventory assignment assertions.
   Run: node tests/run3.test.js
   Same vm-sandbox trick as run2.test.js. Covers the spec's Run 3 test list:
   route, WO load, known/unknown roll scan, match/mismatch, balance checks,
   reservation, multi-WO same roll, over-reservation, release, roles, WO
   activity, roll history events, continue-to-cut, CONSUMED on cut, no roll
   duplication. */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

/* ---------- DOM stub with element registry ---------- */
var store = {};
var els = {};
function makeEl(id) {
  return {
    _id: id, innerHTML: '', textContent: '', value: '', hidden: false, className: '',
    onclick: null, onsubmit: null, oninput: null, style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    addEventListener: function () {}, appendChild: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    querySelector: function () { return makeEl(id + ':q'); },
    querySelectorAll: function () { return []; },
    focus: function () {}, click: function () { if (this.onclick) this.onclick(); }, remove: function () {},
    scrollIntoView: function () {}
  };
}
function elFor(id) { return els[id] || (els[id] = makeEl(id)); }
var sandbox = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
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
  navigator: { vibrate: function () {} }
};
vm.createContext(sandbox);

var src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
var bootIdx = src.lastIndexOf('/* ---------------- boot');
if (bootIdx >= 0) src = src.slice(0, bootIdx);
vm.runInContext(src, sandbox, { filename: 'app.js' });

var S = sandbox;
var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}
function freshDB() { S.DB.reset(); els = {}; S.DB.data.currentEmployee = 'Marcus'; }

/* ---------- schema 3 + seed ---------- */
freshDB();
ok(S.DB.data.schema === 3, 'seed schema is 3');
ok(Array.isArray(S.FG().inventoryAssignments), 'inventoryAssignments collection exists');
ok(Array.isArray(S.FG().assignmentEvents), 'assignmentEvents audit collection exists');
ok(S.woById('XS024536').property === 'Ventura Pointe', 'XS024536 seed order exists');
ok(S.woById('XS024537').account === 'Willowbridge', 'XS024537 seed order exists');
var xsLine = S.lineById(S.woById('XS024536'), 'XS024536-L1');
ok(xsLine && xsLine.requiredIn === 237 && xsLine.widthIn === 144, 'XS024536 line: 19.75 LF, 12 FT');
ok(S.rollByBarcode('16628697').style === 'Marvel', 'demo roll 16628697 seeded');
ok(S.systemBalance('16628697') === 1034, '16628697 balance is 86\' 2" (1034in)');

/* ---------- v2 -> v3 migration ---------- */
(function () {
  /* Simulate a real schema-2 store: seeded floorguard module with the old
     shape (no assignment collections, no material lines). */
  var fg = S.seedFloorguard();
  delete fg.inventoryAssignments; delete fg.assignmentEvents;
  fg.workOrders.forEach(function (w) { delete w.lines; });
  var v2 = S.DB.seed(); v2.schema = 2; v2.modules.floorguard = fg;
  store[S.DB.KEY] = JSON.stringify(v2);
  S.DB.load();
  ok(S.DB.data.schema === 3, 'schema 2 migrates to 3');
  ok(Array.isArray(S.FG().inventoryAssignments), 'migration adds inventoryAssignments');
  var w1 = S.woById('WO-1001');
  ok(w1.lines && w1.lines[0].requiredIn === 850, 'migration synthesizes material lines from flat WO fields');
})();

/* ---------- route ---------- */
freshDB();
ok(!!S.Screens['assign-inventory'], 'assign-inventory route registered');
ok(S.matchRoute('assign-inventory') === 'assign-inventory', 'assign-inventory route resolves');
ok(S.matchRoute('assign-inventory?workOrder=XS024536') === 'assign-inventory', '?workOrder= query URL resolves');
ok(S.matchRoute('assign-inventory/wo/XS024536') === 'assign-inventory/wo', 'wo sub-route resolves');
var hub = S.Screens['assign-inventory']();
ok(hub.html.indexOf('ASSIGN INVENTORY') >= 0, 'hub renders header');
ok(hub.html.indexOf('NEEDS INVENTORY') >= 0 && hub.html.indexOf('ASSIGNED') >= 0 && hub.html.indexOf('COMPLETED') >= 0,
  'hub has NEEDS INVENTORY / ASSIGNED / COMPLETED tabs');

/* ---------- load work order ---------- */
var woScr = S.Screens['assign-inventory/wo']('XS024536');
ok(woScr.html.indexOf('XS024536') >= 0, 'WO summary shows the order number');
ok(woScr.html.indexOf('Ventura Pointe') >= 0, 'WO summary shows property');
ok(woScr.html.indexOf('Willowbridge') >= 0, 'WO summary shows account');
ok(woScr.html.indexOf('Marvel') >= 0 && woScr.html.indexOf('Chrome') >= 0, 'WO summary shows material');
ok(woScr.html.indexOf('19.75') >= 0, 'WO summary shows required quantity 19.75 LF');
ok(woScr.html.indexOf('12 FT') >= 0, 'WO summary shows 12 FT width');
ok(woScr.html.indexOf('NOT ASSIGNED') >= 0, 'line starts NOT ASSIGNED');

/* ---------- material match / mismatch ---------- */
var marvel = S.rollByBarcode('16628697');
var venture = S.rollByBarcode('QH5CPHN');
ok(S.checkCompatibility(marvel, xsLine).verdict === 'MATCH', 'Marvel/Chrome 12FT roll MATCHES the line');
var mis = S.checkCompatibility(venture, xsLine);
ok(mis.verdict === 'MISMATCH', 'Venture Solid / Soft Taupe roll MISMATCHES Marvel/Chrome line');
ok(mis.mismatches.some(function (m) { return m.field === 'style'; }), 'mismatch names the style field');

/* ---------- scan known roll + reservation ---------- */
freshDB();
var balBefore = S.systemBalance('16628697');
var r1 = S.assignInventory({ woId: 'XS024536', lineId: 'XS024536-L1', rollId: '16628697',
  reservedIn: 237, employee: 'Marcus' });
ok(r1.ok, 'reservation succeeds for matching roll');
ok(r1.rec.status === 'RESERVED', 'assignment status is RESERVED');
ok(r1.rec.workOrderId === 'XS024536' && r1.rec.lineId === 'XS024536-L1' && r1.rec.rollId === '16628697',
  'assignment carries WO + line + roll IDs');
ok(r1.rec.requiredIn === 237 && r1.rec.reservedIn === 237, 'required + reserved quantities stored');
ok(r1.rec.employee === 'Marcus' && r1.rec.at, 'employee + timestamp stored');
ok(S.systemBalance('16628697') === balBefore, 'RESERVATION DOES NOT CHANGE the trusted roll balance');
ok(S.lineStatus(S.woById('XS024536'), xsLineFresh()) === 'ASSIGNED', 'line becomes ASSIGNED');
function xsLineFresh() { return S.lineById(S.woById('XS024536'), 'XS024536-L1'); }
ok(S.reservedOnRoll('16628697') === 237, 'reservedOnRoll totals active reservations');
ok(S.potentialAvailable(marvel) === 1034 - 237, 'potential available = balance - reserved (informational)');

/* ---------- multiple work orders on the same roll: no duplication ---------- */
var rollsBefore = S.FG().rolls.length;
var r2 = S.assignInventory({ woId: 'XS024537', lineId: 'XS024537-L1', rollId: '16628697',
  reservedIn: 366, employee: 'Dana' });
ok(r2.ok, 'second WO can reserve the same roll');
ok(S.FG().rolls.length === rollsBefore, 'NO ROLL DUPLICATION — one roll entity');
ok(S.FG().rolls.filter(function (r) { return r.id === '16628697'; }).length === 1, 'exactly one 16628697 record');
ok(S.reservedOnRoll('16628697') === 237 + 366, 'reservations accumulate across work orders');

/* ---------- over-reservation warning ---------- */
var ov = S.overReserved('16628697', 500);
ok(ov.over === true && ov.total === 237 + 366 + 500 && ov.balance === 1034, 'over-reservation math is exact');
var rOver = S.assignInventory({ woId: 'XS024537', lineId: 'XS024537-L1', rollId: '16628697',
  reservedIn: 500, employee: 'Dana' });
ok(!rOver.ok && /OVER-RESERVED/.test(rOver.err), 'over-reservation blocked without supervisor');
var rOverSup = S.assignInventory({ woId: 'XS024537', lineId: 'XS024537-L1', rollId: '16628697',
  reservedIn: 500, employee: 'Dana', overApprovedBy: 'Marcus' });
ok(rOverSup.ok && rOverSup.rec.overApprovedBy === 'Marcus', 'supervisor can approve over-reservation');
ok(S.assignEventsForWO('XS024537').some(function (e) { return e.action === 'OVER_RESERVATION_APPROVED'; }),
  'over-reservation approval is audited');

/* ---------- role restrictions ---------- */
freshDB();
var rMis = S.assignInventory({ woId: 'XS024536', lineId: 'XS024536-L1', rollId: 'QH5CPHN',
  reservedIn: 100, employee: 'Dana' });
ok(!rMis.ok && /SUPERVISOR APPROVAL REQUIRED/.test(rMis.err), 'worker cannot silently assign mismatched material');
var rMisSup = S.assignInventory({ woId: 'XS024536', lineId: 'XS024536-L1', rollId: 'QH5CPHN',
  reservedIn: 100, employee: 'Dana', mismatchApprovedBy: 'Marcus' });
ok(rMisSup.ok, 'supervisor can approve a material mismatch');
ok(S.assignEventsForWO('XS024536').some(function (e) { return e.action === 'MATERIAL_MISMATCH_OVERRIDE'; }),
  'mismatch override is audited');
var relOther = S.releaseAssignment(rMisSup.rec.id, 'Luis');
ok(!relOther.ok, 'a worker cannot release another employee\'s assignment');
var relOwn = S.releaseAssignment(rMisSup.rec.id, 'Dana');
ok(relOwn.ok && relOwn.rec.status === 'RELEASED', 'assigning employee can release their own assignment');
ok(S.FG().inventoryAssignments.filter(function (a) { return a.id === rMisSup.rec.id; }).length === 1,
  'released assignment record is KEPT (never deleted)');

/* ---------- release adds WO activity + audit ---------- */
ok(S.assignEventsForWO('XS024536').some(function (e) { return e.action === 'INVENTORY_RELEASED'; }),
  'release produces an INVENTORY_RELEASED activity event');

/* ---------- sufficient vs insufficient balance ---------- */
freshDB();
ok(S.assignableBalance(marvel) >= 237, '16628697 (86\' 2") covers the 19\' 9" requirement: SUFFICIENT');
var small = S.rollByBarcode('16628698');
ok(S.assignableBalance(small) === 366, '16628698 holds 30\' 6"');
var rIns = S.assignInventory({ woId: 'XS024537', lineId: 'XS024537-L1', rollId: '16628698',
  reservedIn: 366, employee: 'Dana' });
ok(rIns.ok, 'insufficient balance warns but allows a partial reservation (second roll can cover the rest)');
ok(S.lineStatus(S.woById('XS024537'), S.lineById(S.woById('XS024537'), 'XS024537-L1')) === 'PARTIALLY_ASSIGNED',
  'partial reservation -> PARTIALLY_ASSIGNED');

/* ---------- discover unknown roll ---------- */
freshDB();
var dRes = S.discoverRollForAssign('UNKNOWN-999', { employee: 'Dana', location: '207A', measuredIn: 600 });
ok(dRes.ok && !dRes.already, 'unknown roll is discovered');
ok(!!S.findDiscovered('UNKNOWN-999'), 'discovered roll uses the shared discovered-roll architecture');
var dRoll = S.assignableRoll('UNKNOWN-999');
ok(S.checkCompatibility(dRoll, xsLineFresh2()).verdict === 'INCOMPLETE', 'discovered roll -> MATERIAL DATA INCOMPLETE');
function xsLineFresh2() { return S.lineById(S.woById('XS024536'), 'XS024536-L1'); }
var rDisc = S.assignInventory({ woId: 'XS024536', lineId: 'XS024536-L1', rollId: 'UNKNOWN-999',
  reservedIn: 100, employee: 'Dana' });
ok(!rDisc.ok, 'discovered roll requires supervisor review');
var rDiscSup = S.assignInventory({ woId: 'XS024536', lineId: 'XS024536-L1', rollId: 'UNKNOWN-999',
  reservedIn: 100, employee: 'Dana', mismatchApprovedBy: 'Marcus' });
ok(rDiscSup.ok && rDiscSup.rec.discovered === true, 'supervisor can assign a discovered roll');

/* ---------- WO activity + roll history events ---------- */
freshDB();
S.assignInventory({ woId: 'XS024536', lineId: 'XS024536-L1', rollId: '16628697', reservedIn: 237, employee: 'Marcus' });
var evts = S.assignEventsForWO('XS024536');
ok(evts.some(function (e) { return e.action === 'INVENTORY_ASSIGNED'; }), 'INVENTORY_ASSIGNED activity recorded');
ok(evts[0].user && evts[0].at && evts[0].rollId === '16628697', 'activity stores user + timestamp + roll');
var ledger = S.ledgerHtml(S.rollByBarcode('16628697'));
ok(ledger.indexOf('Assigned to Work Order') >= 0, 'roll ledger shows ASSIGNED TO WORK ORDER');
ok(ledger.indexOf('XS024536') >= 0, 'roll ledger names the work order');

/* ---------- release flow ---------- */
var rel = S.releaseAssignment(S.FG().inventoryAssignments[0].id, 'Marcus');
ok(rel.ok, 'supervisor can release');
ok(S.lineStatus(S.woById('XS024536'), S.lineById(S.woById('XS024536'), 'XS024536-L1')) === 'NOT_ASSIGNED',
  'after release the line returns to NOT_ASSIGNED');
ok(S.reservedOnRoll('16628697') === 0, 'released inches leave the reservation total');

/* ---------- continue to cut routing ---------- */
freshDB();
var ra = S.assignInventory({ woId: 'XS024536', lineId: 'XS024536-L1', rollId: '16628697',
  reservedIn: 237, employee: 'Marcus' });
S.newCutSession();
S.C.roll = S.rollByBarcode('16628697');
S.C.woId = 'XS024536'; S.C.assignId = ra.rec.id; S.C.lineId = 'XS024536-L1';
S.C.requiredIn = 237; S.C.needVerify = true; S.C.rollVerified = false;
var cutScr = S.Screens['cut/entry']();
ok(cutScr.html.indexOf('CUTTING FROM INVENTORY ASSIGNMENT') >= 0, 'cut screen shows the assignment banner');
ok(cutScr.html.indexOf('XS024536') >= 0 && cutScr.html.indexOf('16628697') >= 0, 'banner shows WO + roll');
ok(cutScr.html.indexOf('VERIFY ROLL BARCODE') >= 0, 'cut screen requires roll verification');
cutScr.mount();
S.document.querySelector('#cft').value = '19'; S.document.querySelector('#cin').value = '9';
S.document.querySelector('#wo').value = 'XS024536';
elFor('savecut').click();
ok(S.document.querySelector('#cuterr').hidden === false, 'SAVE CUT blocked until the roll is verified');
ok(S.FG().inventoryAssignments[0].status === 'RESERVED', 'unverified cut does not consume the reservation');

/* ---------- cut completion -> CONSUMED ---------- */
var cons = S.consumeAssignment(ra.rec.id, { cutId: 'KTEST', actualCutIn: 237, by: 'Marcus' });
ok(cons.ok && cons.rec.status === 'CONSUMED', 'RESERVED -> CONSUMED');
ok(cons.rec.cutId === 'KTEST' && cons.rec.actualCutIn === 237, 'cut transaction ID + actual quantity recorded');
ok(S.assignEventsForWO('XS024536').some(function (e) { return e.action === 'ASSIGNMENT_CONSUMED'; }),
  'ASSIGNMENT_CONSUMED audited');
var onlyActive = S.activeAssignments('XS024536', 'XS024536-L1');
ok(onlyActive.length === 0, 'consumed reservation leaves no active reservation');

/* ---------- assignment detail screen ---------- */
freshDB();
var rd = S.assignInventory({ woId: 'XS024536', lineId: 'XS024536-L1', rollId: '16628697',
  reservedIn: 237, employee: 'Marcus' });
var aScr = S.Screens['assign-inventory/a'](rd.rec.id);
ok(aScr.html.indexOf('INVENTORY ASSIGNMENT') >= 0, 'assignment detail renders');
ok(aScr.html.indexOf('RESERVED') >= 0, 'detail shows RESERVED status');
ok(aScr.html.indexOf('CONTINUE TO CUT') >= 0, 'detail offers CONTINUE TO CUT');
ok(aScr.html.indexOf('RELEASE ASSIGNMENT') >= 0, 'detail offers RELEASE');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
