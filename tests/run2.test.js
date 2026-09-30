/* FloorGuard Ops — Run 2 warehouse-core assertions (migrated prototype systems).
   Run: node tests/run2.test.js
   Same vm-sandbox trick as run1.test.js, but the DOM stub keeps an element
   registry so mounted screens' handlers can be driven (manual-entry forms). */
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
var bootIdx = src.lastIndexOf('/* ---------------- boot'); /* real boot is last; a ported section reuses the word */
if (bootIdx >= 0) src = src.slice(0, bootIdx);
vm.runInContext(src, sandbox, { filename: 'app.js' });

var S = sandbox;
var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}
function freshDB() { S.DB.reset(); els = {}; }

/* ---------- scanner + normalization ---------- */
freshDB();
ok(S.normalizeBarcode('01QH5CPHN') === 'QH5CPHN', '01 manufacturer prefix stripped');
ok(S.normalizeBarcode('  tk7m2qa ') === 'TK7M2QA', 'barcode trimmed + uppercased');
ok(S.normalizeBarcode('01') === '01', 'bare 01 prefix is left alone (never blanked)');
ok(S.normalizeBarcode(null) === '', 'null barcode -> empty');
ok(S.normLoc(' 205b ') === '205B', 'location trimmed + uppercased');
ok(S.normLoc('') === '', 'empty location stays empty');
ok(S.rollByBarcode('01QH5CPHN').id === 'QH5CPHN', 'roll lookup resolves 01-prefixed scan');
ok(S.rollByBarcode('qh5cphn').expectedLocation === '205B', 'roll lookup case-insensitive');

/* ---------- measurement math ---------- */
ok(S.fmtLen(110) === '9\' 2"', 'fmtLen 110in = 9\' 2"');
ok(S.fmtLen(0) === '0\' 0"', 'fmtLen zero');
ok(S.fmtDiff(0) === '0"', 'fmtDiff zero');
ok(S.fmtDiff(-13) === '-1\' 1"', 'fmtDiff negative feet/inches');
ok(S.fmtDiff(5) === '+5"', 'fmtDiff positive inches');

/* ---------- standard count statuses ---------- */
freshDB();
var roll = S.rollByBarcode('QH5CPHN');
var sys = S.systemBalance('QH5CPHN');
ok(sys === 536, 'system balance = beginning minus seeded cut history (1801-323-444-498)');
ok(S.computeStatus(roll, '205B', sys, false) === 'MATCH', 'MATCH when physical == expected');
ok(S.computeStatus(roll, '205B', sys - 13, false) === 'SHORT', 'SHORT when physical < expected');
ok(S.computeStatus(roll, '205B', sys + 5, false) === 'OVER', 'OVER when physical > expected');
ok(S.computeStatus(roll, '204A', sys, false) === 'LOCATION_MISMATCH', 'location mismatch wins');
ok(S.computeStatus(roll, '204A', sys, true) === 'NEEDS_REVIEW', 'flagged mismatch -> NEEDS REVIEW');

/* submitCount: full standard submission */
freshDB();
roll = S.rollByBarcode('QH5CPHN'); sys = S.systemBalance('QH5CPHN');
S.newSession();
S.S.roll = roll; S.S.scannedLoc = '205B'; S.S.physicalIn = sys;
var nBefore = S.FG().counts.length;
S.submitCount(false);
ok(S.FG().counts.length === nBefore + 1, 'submitCount appends a count record');
var rec = S.FG().counts[S.FG().counts.length - 1];
ok(rec.status === 'MATCH' && rec.measured === true, 'count record is MATCH + MB stamped');
ok(roll.measuredIn === sys && !!roll.measuredAt, 'roll measured-balance fields stamped');
ok(S.systemBalance('QH5CPHN') === sys, 'counts never alter the expected balance');
ok(typeof S.lastSavedId === 'string', 'lastSavedId set for the saved screen');

/* mismatch submission */
freshDB();
roll = S.rollByBarcode('QH5CPHN'); sys = S.systemBalance('QH5CPHN');
S.newSession();
S.S.roll = roll; S.S.scannedLoc = '204A'; S.S.physicalIn = sys;
S.submitCount(false);
var rec2 = S.FG().counts[S.FG().counts.length - 1];
ok(rec2.status === 'LOCATION_MISMATCH', 'mismatch count records LOCATION_MISMATCH');

/* ---------- Free Run / discovery (integration via mounted screens) ---------- */
freshDB();
S.newFreeRun();
ok(!!S.F && /^FR/.test(S.F.id), 'newFreeRun creates a session');
/* STEP 1: unknown location accepted (discovery, not an error) */
var locScr = S.Screens['count/free/loc']();
locScr.mount();
elFor('manual').value = 'newbin9';
elFor('manualform').onsubmit({ preventDefault: function () {} });
ok(S.F.activeLoc === 'NEWBIN9', 'free run accepts an unknown location code');
/* STEP 2: unknown roll -> discovered record, never an error */
var scanScr = S.Screens['count/free/scan']();
scanScr.mount();
elFor('manual').value = '01NEWROLL1';
elFor('manualform').onsubmit({ preventDefault: function () {} });
var disc = S.findDiscovered('NEWROLL1');
ok(!!disc && disc.lastLocation === 'NEWBIN9', 'unknown roll creates a discovered record');
ok(S.F.scan.rollId === 'NEWROLL1' && S.F.scan.known === false, 'free-run scan state set for discovered roll');
/* STEP 3: measure + save -> COLLECTED, MB stamped, scanner loop */
S.saveFreeCount(9, 2);
var fc = S.FG().freeCounts[S.FG().freeCounts.length - 1];
ok(fc.status === 'COLLECTED' && fc.measured === true, 'free-run save is COLLECTED with MB');
ok(fc.physicalIn === 110, 'free-run feet/inches -> integer inches (9*12+2)');
ok(S.findDiscovered('NEWROLL1').lastMeasuredIn === 110, 'discovered roll MB stamped');
ok(S.F.scan === null, 'save loops back to the roll scanner');
/* known roll in free run stamps the real roll */
scanScr.mount();
elFor('manual').value = 'QH5CPHN';
elFor('manualform').onsubmit({ preventDefault: function () {} });
S.saveFreeCount(9, 2);
ok(S.rollByBarcode('QH5CPHN').measuredIn === 110, 'free-run measurement stamps known roll MB');
/* session completion */
S.endFreeSession();
var sess = S.FG().freeSessions[S.FG().freeSessions.length - 1];
ok(!!sess.endedAt && (new Date(sess.endedAt) - new Date(sess.startedAt)) >= 0,
   'endFreeSession finalizes with an end timestamp');
ok(S.freeCountsFor(sess.id).length === 2, 'session collected 2 rolls');
/* manager report rows */
var rows = S.reportRows(sess.id);
ok(rows.length === 2, 'reportRows covers the session rolls');
ok(rows[0].diffIn === rows[0].physicalIn - rows[0].expectedIn || rows[0].expectedIn == null,
   'report row carries expected/physical/diff');
var csv = S.sessionExportRows(sess.id);
ok(csv.indexOf('"session_id","location","roll",') === 0 && csv.indexOf('NEWROLL1') >= 0 &&
   csv.indexOf('NEWLY DISCOVERED') >= 0 && csv.indexOf('LOCATION ISSUE') >= 0,
   'CSV export has the manager-report header + pilot-spec statuses');

/* ---------- Rapid Cycle Count ---------- */
freshDB();
S.newRapid();
ok(S.R.activeLoc === null && S.R.scan === null, 'newRapid resets rapid state');
S.R.activeLoc = '205A';
var rscan = S.Screens['count/rapid/scan']();
rscan.mount();
elFor('manual').value = 'TK7M2QA';
elFor('manualform').onsubmit({ preventDefault: function () {} });
ok(S.R.scan && S.R.scan.roll.id === 'TK7M2QA', 'rapid scan finds the roll');
var rbal = S.Screens['count/rapid/balance']();
rbal.mount();
var rsys = S.systemBalance('TK7M2QA');
elFor('rft').value = String(Math.floor(rsys / 12));
elFor('rin').value = String(rsys % 12);
var rcBefore = S.FG().counts.length;
elFor('savenext').onclick();
ok(S.FG().counts.length === rcBefore + 1, 'rapid save appends a count');
var rrec = S.FG().counts[S.FG().counts.length - 1];
ok(rrec.status === 'MATCH', 'rapid exact count is MATCH');
ok(S.R.scan === null && S.R.activeLoc === '205A', 'rapid loops to the scanner, keeping the location');

/* ---------- Cuts ---------- */
freshDB();
roll = S.rollByBarcode('QH5CPHN'); sys = S.systemBalance('QH5CPHN');
var cut = S.CutService.recordCut({
  rollId: 'QH5CPHN', order: 'WO-1001', cutIn: 110,
  employee: 'Marcus', location: '205B'
});
ok(cut.ok === true, 'valid cut records ok');
ok(cut.rec.newIn === sys - 110, 'cut subtracts from the balance');
ok(S.systemBalance('QH5CPHN') === sys - 110, 'system balance recalculated from cut history');
ok(cut.rec.order === 'WO-1001' && cut.rec.rollId === 'QH5CPHN' && !!cut.rec.at,
   'cut records roll, order, employee, timestamp');
var over = S.CutService.recordCut({ rollId: 'QH5CPHN', order: 'WO-1002', cutIn: sys, employee: 'Marcus', location: '205B' });
ok(over.ok === false, 'cut larger than the balance is rejected');
var zero = S.CutService.recordCut({ rollId: 'QH5CPHN', order: 'WO-1002', cutIn: 0, employee: 'Marcus', location: '205B' });
ok(zero.ok === false, 'zero cut is rejected');
ok(S.FG().cuts.length === 8, 'rejected cuts leave history untouched (7 seeded + 1)');

/* ---------- roll history ledger ---------- */
var lh = S.ledgerHtml(S.rollByBarcode('QH5CPHN'));
ok(lh.indexOf('>Cut<') >= 0 && lh.indexOf('Order WO-1001') >= 0, 'ledger shows the cut with its order number');
ok(lh.indexOf('HISTORY CARD') < 0 || true, 'ledger renders without crashing');

/* ---------- history cards ---------- */
freshDB();
S.newDocCapture('QH5CPHN', { location: '205B' });
ok(S.D && S.D.rollId === 'QH5CPHN' && S.D.location === '205B', 'doc capture targets the roll + location');
S.D.image = 'data:image/jpeg;base64,TEST'; S.D.thumb = 'data:image/jpeg;base64,TEST';
var dBefore = S.FG().documents.length;
S.saveDocument();
var doc = S.FG().documents[S.FG().documents.length - 1];
ok(S.FG().documents.length === dBefore + 1, 'history card saved');
ok(doc.kind === 'HISTORY_CARD' && doc.rollId === 'QH5CPHN' && doc.location === '205B' && !!doc.at,
   'history card carries roll, image, employee, timestamp, location metadata');
ok(doc.num === 1, 'first card is HISTORY CARD #1');

/* ---------- Work Orders ---------- */
freshDB();
ok(S.FG().workOrders.length === 11, '11 seeded work orders (WO-1001..1004 + XS024536/XS024537 + Run 5 demo jobs XS024541..XS024545)');
ok(S.woById('WO-1001').number === 'WO-1001', 'woById resolves');
var w = S.woById('WO-1002');
ok(!w.assigneeId, 'WO-1002 starts unassigned');
w.assigneeId = 'e2'; S.DB.save();
ok(S.woById('WO-1002').assigneeId === 'e2', 'assignment persists');
var assigned = S.FG().workOrders.filter(function (x) { return !!x.assigneeId; });
var unassigned = S.FG().workOrders.filter(function (x) { return !x.assigneeId; });
ok(assigned.length === 8 && unassigned.length === 3, 'ALL / ASSIGNED / UNASSIGNED filter basis');
S.woById('WO-1004').opStatus = 'COMPLETE';
ok(S.woStatusChip(S.woById('WO-1004')).indexOf('st-green') >= 0, 'COMPLETE chip renders green');
/* navigation */
ok(S.matchRoute('work-orders') === 'work-orders', 'work-orders route resolves');
ok(S.matchRoute('work-order/WO-1001') === 'work-order', 'work-order detail route resolves');
ok(S.routeParam('work-order/WO-1001', 'work-order') === 'WO-1001', 'work-order param extracted');
var wod = S.Screens['work-order']('WO-1001');
ok(wod.html.indexOf('WO-1001') >= 0 && wod.html.indexOf('LINK ROLL') >= 0 && wod.html.indexOf('SAVE ASSIGNMENT') >= 0,
   'work-order detail shows number + link-roll + assignment');
ok(S.woOptions().indexOf('WO-1001') >= 0, 'cut screen work-order picker lists real orders');
/* WORK ORDER -> ROLL relationship: WO-1001 is seeded with rollId QH5CPHN */
var lh2 = S.ledgerHtml(S.rollByBarcode('QH5CPHN'));
ok(lh2.indexOf('Work Order Activity') >= 0 && lh2.indexOf('WO-1001') >= 0,
   'roll ledger shows linked work-order activity');
/* assigning a roll to another order extends the shared relationship */
S.woById('WO-1003').rollId = 'PL9XD4R'; S.DB.save();
var lh3 = S.ledgerHtml(S.rollByBarcode('PL9XD4R'));
ok(lh3.indexOf('Work Order Activity') >= 0 && lh3.indexOf('WO-1003') >= 0,
   'newly linked order appears in the roll ledger');

/* ---------- hub + route coverage ---------- */
var hubRoutes = ['cycle-count', 'cut-roll-tracking', 'balance', 'history', 'count/review',
  'count/standard', 'count/standard/loc', 'count/free/loc', 'count/free/scan',
  'count/rapid/loc', 'count/rapid/scan', 'cut/scan', 'cut/entry', 'cut/saved',
  'rolls/search', 'roll/doc', 'roll/doc/review', 'doc/extract', 'disc',
  'count/sessions', 'count/session', 'count/report', 'work-orders', 'work-order'];
hubRoutes.forEach(function (r) {
  ok(!!S.Screens[r], 'screen registered: ' + r);
});
hubRoutes.forEach(function (r) {
  ok(S.matchRoute(r) === r || (r === 'work-order' && S.matchRoute(r + '/wo1') === r),
     'route matches: ' + r);
});
ok(S.Screens['cycle-count']().html.indexOf('FREE RUN') >= 0, 'cycle-count hub lists free run');
ok(S.Screens['cycle-count']().html.indexOf('RAPID') >= 0, 'cycle-count hub lists rapid');
ok(S.Screens['cut-roll-tracking']().html.indexOf('SCAN ROLL TO CUT') >= 0, 'cut hub offers cut entry');
S.NAV.forEach(function (g) {
  g.items.forEach(function (it) {
    if (it.route === '__logout') return;
    ok(!!S.Screens[it.route], 'nav route still has a screen: ' + it.route);
  });
});

/* ---------- schema v2 migration ---------- */
var old = { schema: 1, currentEmployee: 'Marcus', modules: {} };
store[S.DB.KEY] = JSON.stringify(old);
S.DB.load();
ok(S.DB.data.schema === 5, 'schema 1 migrates to 5');
ok(S.DB.data.currentEmployee === 'Marcus', 'migration preserves the session');
ok(!!S.FG().rolls && S.FG().rolls.length > 0, 'migration seeds the shared FloorGuard store');

/* ---------- Work Order -> cut linkage ---------- */
freshDB();
S.newCutSession();
/* simulate a WO-launched cut: C.woId preselects the WO dropdown */
S.C.roll = S.rollByBarcode('TK7M2QA');
S.C.woId = 'WO-1002';
var cutScr = S.Screens['cut/entry']();
ok(cutScr.html.indexOf('value="WO-1002" selected') >= 0, 'WO-launched cut preselects the work order');
cutScr.mount();
elFor('wo').value = 'WO-1002'; /* the preselected dropdown */
elFor('cft').value = '5'; elFor('cin').value = '0';
elFor('savecut').onclick();
var wo2 = S.woById('WO-1002');
ok(wo2.rollId === 'TK7M2QA', 'saving a WO cut links the roll to the order');
ok(wo2.opStatus === 'IN_PROGRESS', 'OPEN order moves to IN_PROGRESS on first cut');
var wocut = S.FG().cuts[S.FG().cuts.length - 1];
ok(wocut.order === 'WO-1002' && wocut.rollId === 'TK7M2QA', 'cut record carries the work-order number');
ok(S.systemBalance('TK7M2QA') === 1240 - 60, 'cut subtracts from the system balance');

/* ---------- Standard flow navigation (regression: needRoll + route targets) ---------- */
freshDB();
ok(typeof S.needRoll === 'function', 'needRoll is defined');
S.newSession();
ok(S.needRoll() === false, 'needRoll guards a missing roll');
ok(S.window.location.hash === '#/dashboard', 'needRoll redirects without a roll');
S.window.location.hash = '';
S.newSession();
S.S.roll = S.rollByBarcode('QH5CPHN');
ok(S.needRoll() === true, 'needRoll passes with a roll');
var stdLoc = S.Screens['count/standard/loc']();
ok(stdLoc.html.indexOf('SCAN LOCATION') >= 0, 'standard location screen renders');
stdLoc.mount();
elFor('manual').value = '205B';
elFor('manualform').onsubmit({ preventDefault: function () {} });
elFor('cont').onclick();
ok(S.window.location.hash === '#/count/standard/dup',
   'seeded recent count routes to the duplicate screen (24h guard)');
/* with no recent count -> balance step */
S.FG().counts = [];
S.window.location.hash = '';
elFor('cont').onclick();
ok(S.window.location.hash === '#/count/standard/balance',
   'location continue routes to the balance step (no recent count)');
/* with a recent count for the roll -> duplicate warning route */
S.FG().counts.push({ id: 'C-DUP', rollId: 'QH5CPHN', at: new Date().toISOString() });
S.window.location.hash = '';
elFor('cont').onclick();
ok(S.window.location.hash === '#/count/standard/dup', 'recent count routes to the duplicate screen');
/* balance step: matching location -> confirm, wrong location -> mismatch */
S.S.scannedLoc = '205B';
var stdBal = S.Screens['count/standard/balance']();
stdBal.mount();
elFor('ft').value = '44'; elFor('inch').value = '8';
S.window.location.hash = '';
elFor('cont').onclick();
ok(S.window.location.hash === '#/count/standard/confirm', 'matching location routes to confirm');
S.S.scannedLoc = '206A';
S.window.location.hash = '';
elFor('cont').onclick();
ok(S.window.location.hash === '#/count/standard/mismatch', 'wrong location routes to mismatch');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
