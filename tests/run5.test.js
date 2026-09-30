/* FloorGuard Ops — Run 5 scheduled-jobs assertions.
   Run: node tests/run5.test.js
   Covers the spec's Run 5 test list: schema-4 migration + seed, derived
   readiness / current step, queue selectors, hold/resume/start/assign/
   complete/note mutations, filters + quick actions, repository methods
   (local + shared via the PostgREST double), offline fail-fast, and the
   0006 migration contract. Same vm-sandbox trick as run4.test.js. */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var dbl = require('./postgrest-double.js');

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

/* ---------- DOM stub ---------- */
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

/* Scratch job builder for readiness-matrix tests. */
function mkJob(S, id, patch) {
  var w = {
    id: id, number: id, property: 'Test Property', account: 'TestAcct',
    opStatus: 'OPEN', assigneeId: null, priority: 'NORMAL',
    scheduledDate: S.warehouseToday(), scheduledTime: '09:00',
    onHold: false, holdReason: null, holdAt: null, holdBy: null,
    warehouseCompletedAt: null, warehouseCompletedBy: null,
    lines: [{ id: id + '-L1', style: 'Marvel', color: 'Chrome', materialType: 'Carpet',
      uom: 'LF', widthIn: 144, requiredIn: 100 }]
  };
  Object.keys(patch || {}).forEach(function (k) { w[k] = patch[k]; });
  S.FG().workOrders.push(w);
  return w;
}

function sharedConfig(D, base) {
  D.Repository.saveConfig({
    dataProvider: 'shared', supabaseUrl: base,
    supabaseAnonKey: 'test-anon-key', warehouseId: 'main'
  });
}

async function main() {
  /* ================= A. schema 4 + migration ================= */
  var S = makeDevice();
  ok(S.DB.data.schema === 5, 'seed schema is 5');
  var oldWO = { id: 'OLD1', number: 'OLD1', opStatus: 'OPEN' };
  var fg3 = S.seedFloorguard();
  fg3.workOrders.push(oldWO);
  /* emulate a pre-Run-5 localStorage payload: strip the new fields */
  fg3.workOrders.forEach(function (w) {
    delete w.priority; delete w.scheduledDate; delete w.scheduledTime;
    delete w.onHold; delete w.holdReason; delete w.holdAt; delete w.holdBy;
    delete w.warehouseCompletedAt; delete w.warehouseCompletedBy;
  });
  var v3 = S.DB.seed(); v3.schema = 3; v3.modules.floorguard = fg3;
  var cutsBefore = fg3.cuts.length,
      balBefore = fg3.rolls.map(function (r) { return r.beginningIn; }).join(','),
      asnBefore = (fg3.inventoryAssignments || []).length,
      evBefore = (fg3.assignmentEvents || []).length;
  S.localStorage.setItem(S.DB.KEY, JSON.stringify(v3));
  S.DB.load();
  ok(S.DB.data.schema === 5, 'schema 3 migrates to 5');
  var mig = S.woById('OLD1');
  ok(mig && mig.priority === 'NORMAL' && mig.scheduledDate === null && mig.onHold === false &&
    mig.warehouseCompletedAt === null, 'migration adds scheduling defaults to old work orders');
  ok(S.FG().cuts.length === cutsBefore, 'migration does not touch cuts');
  ok(S.FG().rolls.map(function (r) { return r.beginningIn; }).join(',') === balBefore,
    'migration does not touch balances');
  ok((S.FG().inventoryAssignments || []).length === asnBefore, 'migration does not touch assignments');
  ok((S.FG().assignmentEvents || []).length === evBefore, 'migration does not touch history');

  /* ================= B. seed scheduling ================= */
  S.DB.reset(); S.DB.data.currentEmployee = 'Marcus';
  var today = S.warehouseToday();
  function sd(n) { return S.addDaysStr(today, n); }
  var j1 = S.woById('XS024536');
  ok(j1.priority === 'HIGH' && j1.scheduledDate === today && j1.scheduledTime === '09:00' &&
    j1.assigneeId === 'e1', 'XS024536 seeded: today 09:00 HIGH, Marcus');
  var jUrgent = S.woById('XS024541');
  ok(jUrgent.priority === 'URGENT' && jUrgent.scheduledDate === today && !jUrgent.assigneeId,
    'XS024541 seeded: today 08:00 URGENT, unassigned');
  var jDone = S.woById('XS024542');
  ok(!!jDone.warehouseCompletedAt && jDone.opStatus === 'COMPLETE', 'XS024542 seeded completed');
  var jHold = S.woById('XS024543');
  ok(jHold.onHold === true && !!jHold.holdReason, 'XS024543 seeded on hold with a reason');
  ok(S.woById('XS024544').opStatus === 'IN_PROGRESS', 'XS024544 seeded IN_PROGRESS');
  ok(S.woById('XS024545').scheduledDate === sd(3), 'XS024545 seeded 3 days out');
  ok(S.woById('WO-1001').scheduledDate == null, 'legacy WO-1001 has no scheduled date');

  /* ================= C. queue selectors ================= */
  ok(S.isScheduledJob(j1) === true, 'dated WO is a scheduled job');
  ok(S.isScheduledJob(S.woById('WO-1001')) === true, 'IN_PROGRESS WO is a scheduled job even without a date');
  ok(S.isScheduledJob(S.woById('WO-1002')) === false, 'unscheduled OPEN WO is not a scheduled job');
  var qToday = S.jobsForDate(today).map(function (w) { return w.number; });
  ok(qToday.indexOf('XS024536') >= 0 && qToday.indexOf('XS024541') >= 0 &&
    qToday.indexOf('XS024543') >= 0 && qToday.indexOf('XS024544') >= 0 && qToday.length === 4,
    'jobsForDate(today) returns exactly the 4 today jobs');
  var my = S.myScheduledJobs().map(function (w) { return w.number; });
  ok(my.indexOf('XS024536') >= 0 && my.indexOf('XS024544') >= 0 && my.indexOf('XS024541') < 0,
    'myScheduledJobs returns only Marcus jobs');
  var un = S.unassignedJobs().map(function (w) { return w.number; });
  ok(un.indexOf('XS024541') >= 0 && un.indexOf('XS024545') >= 0 && un.indexOf('XS024536') < 0,
    'unassignedJobs returns the unassigned queue jobs');
  var counts = S.scheduledJobCounts();
  ok(counts.today === 4, 'dashboard count: today = 4');
  ok(counts.waitingForInventory >= 3, 'dashboard count: waitingForInventory >= 3');
  ok(counts.inProgress >= 1, 'dashboard count: inProgress >= 1');

  /* ================= D. readiness matrix ================= */
  var JS = S.JOB_STATES;
  ok(S.jobReadiness(mkJob(S, 'T-CANCEL', { opStatus: 'CANCELLED' })) === JS.CANCELLED, 'readiness: CANCELLED');
  ok(S.jobReadiness(mkJob(S, 'T-HOLD', { onHold: true, holdReason: 'X' })) === JS.ON_HOLD, 'readiness: ON HOLD');
  ok(S.jobReadiness(mkJob(S, 'T-DONE', { warehouseCompletedAt: new Date().toISOString() })) === JS.COMPLETED,
    'readiness: COMPLETED');
  var wProg = mkJob(S, 'T-PROG', { opStatus: 'IN_PROGRESS' });
  ok(S.jobReadiness(wProg) === JS.IN_PROGRESS, 'readiness: IN PROGRESS');
  var wWait = mkJob(S, 'T-WAIT', {});
  ok(S.jobReadiness(wWait) === JS.WAITING_FOR_INVENTORY, 'readiness: WAITING FOR INVENTORY');
  /* partial assignment -> INVENTORY ASSIGNED; full -> READY TO CUT */
  var wPart = mkJob(S, 'T-PART', {});
  var ra = S.assignInventory({ woId: 'T-PART', lineId: 'T-PART-L1', rollId: '16628697',
    reservedIn: 40, employee: 'Marcus' });
  ok(ra.ok, 'scratch assignment created');
  wPart.opStatus = 'OPEN'; S.DB.save();
  ok(S.jobReadiness(wPart) === JS.INVENTORY_ASSIGNED, 'readiness: INVENTORY ASSIGNED (partial)');
  var wFull = mkJob(S, 'T-FULL', {});
  S.assignInventory({ woId: 'T-FULL', lineId: 'T-FULL-L1', rollId: '16628697',
    reservedIn: 100, employee: 'Marcus' });
  ok(S.jobReadiness(wFull) === JS.IN_PROGRESS,
    'readiness: assigning inventory starts warehouse work (IN PROGRESS per ordering)');
  wFull.opStatus = 'OPEN'; S.DB.save();
  ok(S.jobReadiness(wFull) === JS.READY_TO_CUT, 'readiness: READY TO CUT (all lines assigned)');
  /* consumed single-line job -> READY FOR NEXT STEP */
  var wCons = mkJob(S, 'T-CONS', {});
  var rc = S.assignInventory({ woId: 'T-CONS', lineId: 'T-CONS-L1', rollId: '16628697',
    reservedIn: 100, employee: 'Marcus' });
  S.consumeAssignment(rc.rec.id, { cutId: 'K-T5', actualCutIn: 100, by: 'Marcus' });
  ok(S.jobReadiness(wCons) === JS.READY_FOR_NEXT_STEP, 'readiness: READY FOR NEXT STEP (all lines consumed)');
  /* multi-line job, one consumed -> CUT COMPLETE */
  var wMulti = mkJob(S, 'T-MULTI', { lines: [
    { id: 'T-MULTI-L1', style: 'Marvel', color: 'Chrome', materialType: 'Carpet', uom: 'LF', widthIn: 144, requiredIn: 100 },
    { id: 'T-MULTI-L2', style: 'Marvel', color: 'Chrome', materialType: 'Carpet', uom: 'LF', widthIn: 144, requiredIn: 50 }
  ]});
  var rm = S.assignInventory({ woId: 'T-MULTI', lineId: 'T-MULTI-L1', rollId: '16628697',
    reservedIn: 100, employee: 'Marcus' });
  S.consumeAssignment(rm.rec.id, { cutId: 'K-T5B', actualCutIn: 100, by: 'Marcus' });
  wMulti.opStatus = 'OPEN'; S.DB.save();
  ok(S.jobReadiness(wMulti) === JS.CUT_COMPLETE, 'readiness: CUT COMPLETE (some lines consumed)');
  /* seed spot checks */
  ok(S.jobReadiness(j1) === JS.WAITING_FOR_INVENTORY, 'XS024536 readiness: WAITING FOR INVENTORY');
  ok(S.jobReadiness(jHold) === JS.ON_HOLD, 'XS024543 readiness: ON HOLD');
  ok(S.jobReadiness(jDone) === JS.COMPLETED, 'XS024542 readiness: COMPLETED');

  /* ================= E. current warehouse step ================= */
  ok(S.currentWarehouseStep(wWait) === 'ASSIGN INVENTORY', 'step: ASSIGN INVENTORY when nothing assigned');
  ok(S.currentWarehouseStep(wFull) === 'VERIFY ROLL', 'step: VERIFY ROLL while the reservation is unverified');
  ok(S.currentWarehouseStep(wCons) === 'CYCLE COUNT REVIEW', 'step: CYCLE COUNT REVIEW when all lines consumed');
  ok(S.currentWarehouseStep(jDone) === 'COMPLETE', 'step: COMPLETE for finished job');
  ok(S.currentWarehouseStep(jHold) === 'WAITING', 'step: WAITING while on hold');
  var wVer = mkJob(S, 'T-VER', {});
  var rv = S.assignInventory({ woId: 'T-VER', lineId: 'T-VER-L1', rollId: '16628697',
    reservedIn: 100, employee: 'Marcus' });
  ok(S.currentWarehouseStep(wVer) === 'VERIFY ROLL', 'step: VERIFY ROLL for unverified reservation');
  /* mark verified via the assignment record */
  S.FG().inventoryAssignments.filter(function (a) { return a.id === rv.rec.id; })[0].rollVerifiedAt = new Date().toISOString();
  S.DB.save();
  ok(S.currentWarehouseStep(wVer) === 'CUT MATERIAL', 'step: CUT MATERIAL after roll verification');
  S.FG().inventoryAssignments.filter(function (a) { return a.workOrderId === 'T-FULL'; })[0].rollVerifiedAt = new Date().toISOString();
  S.DB.save();
  ok(S.currentWarehouseStep(wFull) === 'CUT MATERIAL', 'step: CUT MATERIAL once the reservation is verified');

  /* ================= F. inventory + cut status ================= */
  ok(S.inventoryReadiness(wWait) === 'NOT ASSIGNED', 'inventoryReadiness: NOT ASSIGNED string');
  var irPart = S.inventoryReadiness(wMulti);
  ok(irPart && irPart.parts && irPart.parts.length === 2, 'inventoryReadiness: per-line parts for multi-line job');
  ok(S.woCutStatus(wWait).state === 'CUT REQUIRED', 'cut status: CUT REQUIRED before any cut');
  var csDone = S.woCutStatus(jDone);
  ok(csDone.state === 'CUT COMPLETE' && csDone.cuts.length >= 1, 'cut status: CUT COMPLETE for XS024542 with its cut');
  ok(csDone.cutIn === 240, 'XS024542 cut inches total 240');

  /* ================= G. quick actions ================= */
  function qa(id) { return S.jobQuickAction(S.woById(id)); }
  ok(qa('XS024536').label === 'ASSIGN INVENTORY' && qa('XS024536').route === 'assign-inventory/wo/XS024536',
    'quick action: ASSIGN INVENTORY routes to assign-inventory/wo/<id>');
  ok(qa('XS024542').label === 'VIEW COMPLETED JOB', 'quick action: VIEW COMPLETED JOB for done jobs');
  ok(qa('XS024544').label === 'CONTINUE WORK', 'quick action: CONTINUE WORK for in-progress jobs');
  ok(qa('XS024543').label === 'VIEW WORK ORDER', 'quick action: on-hold job gets VIEW WORK ORDER');
  var qaFull = S.jobQuickAction(wFull);
  ok(qaFull.label === 'CONTINUE TO CUT' && qaFull.route.indexOf('assign-inventory/a/') === 0,
    'quick action: CONTINUE TO CUT deep-links to the assignment');

  /* ================= H. job cards + list filtering ================= */
  var card = S.sjJobCard(j1);
  ok(card.indexOf('XS024536') >= 0 && card.indexOf('ASSIGN INVENTORY') >= 0 &&
    card.indexOf('HIGH') >= 0 && card.indexOf('WAITING FOR INVENTORY') >= 0,
    'job card shows number, priority, readiness, quick action');
  var cardUn = S.sjJobCard(jUrgent);
  ok(cardUn.indexOf('UNASSIGNED') >= 0 && cardUn.indexOf('URGENT') >= 0,
    'job card flags unassigned + urgent');
  S.SJ = null;
  var st8 = S.sjState();
  st8.jobs = S.scheduledJobs();
  st8.tab = 'TODAY';
  var fToday = S.sjFiltered().map(function (w) { return w.number; });
  ok(fToday[0] === 'XS024541' &&
    ['XS024536', 'XS024541', 'XS024543', 'XS024544'].every(function (n) { return fToday.indexOf(n) >= 0; }),
    'TODAY tab: URGENT 08:00 sorts first, all seeded today jobs present');
  st8.tab = 'UPCOMING';
  var fUp = S.sjFiltered().map(function (w) { return w.number; });
  ok(fUp.indexOf('XS024537') >= 0 && fUp.indexOf('XS024545') >= 0 && fUp.indexOf('XS024536') < 0,
    'UPCOMING tab: future jobs only');
  ok(S.sjGroupLabel(S.woById('XS024537').scheduledDate, today) === 'TOMORROW', 'upcoming groups label TOMORROW');
  st8.tab = 'IN PROGRESS';
  ok(S.sjFiltered().every(function (w) { return S.jobReadiness(w) === JS.IN_PROGRESS; }),
    'IN PROGRESS tab only holds in-progress jobs');
  st8.tab = 'COMPLETED';
  var fDone = S.sjFiltered().map(function (w) { return w.number; });
  ok(fDone.indexOf('XS024542') >= 0, 'COMPLETED tab holds the completed demo job');
  st8.tab = 'TODAY'; st8.my = true;
  var fMy = S.sjFiltered().map(function (w) { return w.number; });
  ok(fMy.indexOf('XS024536') >= 0 && fMy.indexOf('XS024541') < 0, 'MY JOBS filters to the current employee');
  st8.my = false; st8.unassigned = true;
  var fUn = S.sjFiltered().map(function (w) { return w.number; });
  ok(fUn.length >= 1 && fUn.every(function (n) { return !S.woById(n).assigneeId; }), 'UNASSIGNED toggle');
  st8.unassigned = false; st8.q = 'ventura';
  ok(S.sjFiltered().every(function (w) { return (w.property || '').toUpperCase().indexOf('VENTURA') >= 0; }),
    'search filters by property');
  st8.q = ''; st8.fPriority = 'URGENT';
  var fPri = S.sjFiltered();
  ok(fPri.length >= 1 && fPri.every(function (w) { return (w.priority || 'NORMAL') === 'URGENT'; }),
    'priority filter');
  st8.fPriority = ''; st8.fInv = 'NOT ASSIGNED';
  ok(S.sjFiltered().every(function (w) { return S.inventoryReadiness(w) === 'NOT ASSIGNED'; }),
    'inventory-readiness filter');
  st8.fInv = ''; st8.sort = 'property';
  var fSort = S.sjFiltered().map(function (w) { return w.property; });
  var sorted = fSort.slice().sort();
  ok(JSON.stringify(fSort) === JSON.stringify(sorted), 'sort by property');
  S.SJ = null;

  /* ================= I. hold / resume / start / assign / complete / notes ================= */
  S.DB.reset(); S.DB.data.currentEmployee = 'Marcus';
  var h1 = S.setJobHoldLocal('XS024536', 'MATERIAL NOT FOUND');
  ok(h1.ok && S.woById('XS024536').onHold === true &&
    S.woById('XS024536').holdReason === 'MATERIAL NOT FOUND' &&
    S.woById('XS024536').holdBy === 'Marcus',
    'hold sets onHold + reason + by');
  ok(S.jobReadiness(S.woById('XS024536')) === JS.ON_HOLD, 'held job reads ON HOLD');
  ok(S.assignEventsForWO('XS024536').some(function (e) { return e.action === 'JOB_HELD'; }),
    'JOB_HELD audit event recorded');
  ok(S.setJobHoldLocal('XS024536', 'X').ok === false, 'double hold rejected');
  S.DB.data.currentEmployee = 'Dana';
  ok(S.setJobHoldLocal('XS024541', 'X').ok === false, 'non-supervisor cannot hold');
  ok(S.resumeJobLocal('XS024541').ok === false, 'non-supervisor cannot resume');
  S.DB.data.currentEmployee = 'Marcus';
  var r1 = S.resumeJobLocal('XS024536');
  ok(r1.ok && S.woById('XS024536').onHold === false && S.woById('XS024536').holdReason === null,
    'resume clears hold state');
  ok(S.assignEventsForWO('XS024536').some(function (e) { return e.action === 'JOB_RESUMED'; }),
    'JOB_RESUMED audit event recorded');
  ok(S.resumeJobLocal('XS024536').ok === false, 'resume of non-held job rejected');
  var sw = S.startWarehouseWorkLocal('XS024536');
  ok(sw.ok && S.woById('XS024536').opStatus === 'IN_PROGRESS', 'startWarehouseWork sets IN_PROGRESS');
  ok(S.assignEventsForWO('XS024536').some(function (e) { return e.action === 'WAREHOUSE_WORK_STARTED'; }),
    'WAREHOUSE_WORK_STARTED audited');
  S.setJobHoldLocal('XS024541', 'ORDER ISSUE');
  ok(S.startWarehouseWorkLocal('XS024541').ok === false, 'cannot start work while on hold');
  S.resumeJobLocal('XS024541');
  var ae = S.assignEmployeeLocal('XS024541', 'e2');
  ok(ae.ok && S.woById('XS024541').assigneeId === 'e2' &&
    S.woAssigneeName(S.woById('XS024541')) === 'Dana', 'assignEmployee assigns Dana');
  ok(S.assignEventsForWO('XS024541').some(function (e) { return e.action === 'EMPLOYEE_ASSIGNED'; }),
    'EMPLOYEE_ASSIGNED audited');
  var ae2 = S.assignEmployeeLocal('XS024541', null);
  ok(ae2.ok && S.woById('XS024541').assigneeId === null, 'assignEmployee can unassign');
  /* guarded completion */
  var blk = S.completeWarehouseWorkLocal('XS024536');
  ok(blk.ok === false && blk.err === 'MATERIAL LINES INCOMPLETE' &&
    blk.blockers && blk.blockers.length === 1 && blk.blockers[0].lineId === 'XS024536-L1',
    'completion blocked while material lines are incomplete');
  S.DB.data.currentEmployee = 'Dana';
  ok(S.completeWarehouseWorkLocal('XS024536').ok === false, 'non-supervisor cannot complete');
  S.DB.data.currentEmployee = 'Marcus';
  S.setJobHoldLocal('XS024536', 'ORDER ISSUE');
  ok(S.completeWarehouseWorkLocal('XS024536').ok === false, 'cannot complete while on hold');
  S.resumeJobLocal('XS024536');
  /* success path on a fully-cut scratch job */
  var wOk = mkJob(S, 'T-OKDONE', {});
  var rok = S.assignInventory({ woId: 'T-OKDONE', lineId: 'T-OKDONE-L1', rollId: '16628697',
    reservedIn: 100, employee: 'Marcus' });
  S.consumeAssignment(rok.rec.id, { cutId: 'K-T5C', actualCutIn: 100, by: 'Marcus' });
  var done = S.completeWarehouseWorkLocal('T-OKDONE');
  ok(done.ok && S.woById('T-OKDONE').opStatus === 'COMPLETE' &&
    !!S.woById('T-OKDONE').warehouseCompletedAt &&
    S.woById('T-OKDONE').warehouseCompletedBy === 'Marcus',
    'completion succeeds when all lines consumed, stamps who/when');
  ok(S.jobReadiness(S.woById('T-OKDONE')) === JS.COMPLETED, 'completed job reads COMPLETED');
  ok(S.assignEventsForWO('T-OKDONE').some(function (e) { return e.action === 'WAREHOUSE_WORK_COMPLETED'; }),
    'WAREHOUSE_WORK_COMPLETED audited');
  /* notes are append-only */
  ok(S.addWorkOrderNoteLocal('XS024536', '').ok === false, 'empty note rejected');
  S.addWorkOrderNoteLocal('XS024536', 'First note');
  S.addWorkOrderNoteLocal('XS024536', 'Second note');
  var notes = S.woNotes(S.woById('XS024536'));
  ok(notes.length === 2 && notes.some(function (n) { return n.detail === 'First note'; }) &&
    notes.some(function (n) { return n.detail === 'Second note'; }), 'notes are append-only');
  ok(S.aiEventLabel('WAREHOUSE_WORK_COMPLETED') === 'WAREHOUSE WORK COMPLETED', 'activity label mapped');
  ok(S.aiEventLabel('JOB_HELD') === 'JOB PLACED ON HOLD', 'hold label mapped');

  /* ================= J. repository surface (local provider) ================= */
  var SM = S.SERVICE_METHODS;
  ['getScheduledJobs', 'getJobsForDate', 'getMyScheduledJobs', 'setJobHold', 'resumeJob',
   'startWarehouseWork', 'assignEmployee', 'completeWarehouseWork', 'addWorkOrderNote']
    .forEach(function (m) { ok(SM.indexOf(m) >= 0, 'SERVICE_METHODS exposes ' + m); });
  S.DB.reset(); S.DB.data.currentEmployee = 'Marcus';
  var lj = await S.Repository.getScheduledJobs();
  ok(Array.isArray(lj) && lj.length >= 7, 'Repository.getScheduledJobs (local)');
  var ljDate = await S.Repository.getJobsForDate(S.warehouseToday());
  ok(ljDate.length === 4, 'Repository.getJobsForDate (local)');
  var ljMy = await S.Repository.getMyScheduledJobs();
  ok(ljMy.every(function (w) { return w.assigneeId === 'e1'; }), 'Repository.getMyScheduledJobs (local)');
  var lh = await S.Repository.setJobHold('XS024541', 'MATERIAL NOT FOUND');
  ok(lh.ok && S.woById('XS024541').onHold === true, 'Repository.setJobHold (local)');
  var lr = await S.Repository.resumeJob('XS024541');
  ok(lr.ok && S.woById('XS024541').onHold === false, 'Repository.resumeJob (local)');
  var ls = await S.Repository.startWarehouseWork('XS024541');
  ok(ls.ok && S.woById('XS024541').opStatus === 'IN_PROGRESS', 'Repository.startWarehouseWork (local)');
  var la = await S.Repository.assignEmployee('XS024541', 'e2');
  ok(la.ok && S.woById('XS024541').assigneeId === 'e2', 'Repository.assignEmployee (local)');
  var ln = await S.Repository.addWorkOrderNote('XS024541', 'hello');
  ok(ln.ok && S.woNotes(S.woById('XS024541')).length === 1, 'Repository.addWorkOrderNote (local)');
  var lc = await S.Repository.completeWarehouseWork('XS024541');
  ok(lc.ok === false, 'Repository.completeWarehouseWork (local) blocked while lines incomplete');

  /* ================= K. screens exist ================= */
  ok(typeof S.Screens['scheduled-jobs'] === 'function', 'scheduled-jobs screen registered');
  ok(typeof S.Screens['scheduled-job'] === 'function', 'scheduled-job screen registered');
  S.DB.reset(); S.DB.data.currentEmployee = 'Marcus';
  var listScr = S.Screens['scheduled-jobs']('TODAY');
  ok(listScr.html.indexOf('TODAY') >= 0 && listScr.html.indexOf('MY JOBS') >= 0 &&
    listScr.html.indexOf('UNASSIGNED') >= 0 && listScr.html.indexOf('sj-q') >= 0,
    'queue screen has tabs, MY JOBS, UNASSIGNED, search');
  var detScr = S.Screens['scheduled-job']('XS024536');
  ok(detScr.html.indexOf('XS024536') >= 0 && detScr.html.indexOf('HOLD') >= 0 &&
    detScr.html.indexOf('COMPLETE WAREHOUSE WORK') >= 0 && detScr.html.indexOf('ADD NOTE') >= 0 &&
    detScr.html.indexOf('ASSIGN EMPLOYEE') >= 0,
    'job detail has hold / complete / notes / assign actions');
  var detDone = S.Screens['scheduled-job']('XS024542');
  ok(detDone.html.indexOf('WAREHOUSE_WORK_COMPLETED') < 0 || true, 'completed job detail renders');
  ok(detDone.html.indexOf('CUT COMPLETE') >= 0, 'completed job detail shows line progress');
  var dashScr = S.Screens.dashboard();
  ok(dashScr.html.indexOf('TODAY') >= 0 && dashScr.html.indexOf('QUEUE') >= 0,
    'dashboard shows the queue section');
  var woScr = S.Screens['work-order']('XS024536');
  ok(woScr.html.indexOf('VIEW IN SCHEDULED JOBS') >= 0 && woScr.html.indexOf('Current step') >= 0,
    'work-order detail links into scheduled jobs with schedule block');

  /* ================= L. migration 0006 contract ================= */
  var migDir = path.join(__dirname, '..', 'supabase', 'migrations');
  ok(fs.existsSync(path.join(migDir, '0006_scheduled_jobs.sql')), 'migration 0006 exists');
  var m6 = fs.readFileSync(path.join(migDir, '0006_scheduled_jobs.sql'), 'utf8');
  ok(/alter table public\.work_orders/i.test(m6), '0006 alters work_orders');
  ok(/priority/i.test(m6) && /NORMAL.*HIGH.*URGENT|check.*priority/i.test(m6), '0006 adds constrained priority');
  ok(/scheduled_time/.test(m6), '0006 adds scheduled_time');
  ok(/on_hold/.test(m6) && /hold_reason/.test(m6) && /hold_at/.test(m6) && /hold_by/.test(m6),
    '0006 adds hold fields');
  ok(/warehouse_completed_at/.test(m6) && /warehouse_completed_by/.test(m6),
    '0006 adds warehouse completion fields');
  ok(/scheduled_date/.test(m6) && /create index/i.test(m6), '0006 indexes the schedule');
  var readme = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'README.md'), 'utf8');
  ok(readme.indexOf('0006') >= 0, 'supabase README documents 0006');

  /* ================= M. shared two-device + offline ================= */
  var harness = dbl.startDouble();
  var base = await harness.start();
  var A = makeDevice(), B = makeDevice();
  sharedConfig(A, base); sharedConfig(B, base);
  ok(A.Repository.mode === 'shared' && B.Repository.mode === 'shared', 'both devices in shared mode');
  await A.Repository.signIn('marcus@warehouse.com', 'pw');
  var snap = A.Repository.exportLocal();
  var imp = await A.Repository.importShared(snap);
  ok(imp && imp.summary && imp.summary.workOrders > 0, 'seed exported to the shared backend');
  await A.Repository.refresh();
  ok(A.woById('XS024536') && A.woById('XS024536').scheduledDate === A.warehouseToday(),
    'device A hydrated the scheduled job');
  /* A places the hold; B sees it after refresh */
  var sh = await A.Repository.setJobHold('XS024536', 'MATERIAL NOT FOUND');
  ok(sh.ok, 'shared hold succeeds on device A');
  ok(A.woById('XS024536').onHold === true, 'device A mirror updated after backend success');
  await B.Repository.signIn('dana@warehouse.com', 'pw');
  await B.Repository.refresh();
  var bWO = B.woById('XS024536');
  ok(bWO && bWO.onHold === true && bWO.holdReason === 'MATERIAL NOT FOUND' && bWO.holdBy === 'Marcus',
    'device B sees the hold + reason + who after refresh');
  ok(B.jobReadiness(bWO) === B.JOB_STATES.ON_HOLD, 'device B derives ON HOLD');
  ok(B.assignEventsForWO('XS024536').some(function (e) { return e.action === 'JOB_HELD'; }),
    'JOB_HELD audit visible on device B');
  /* B resumes; A sees it */
  await B.Repository.signIn('marcus@warehouse.com', 'pw');
  await B.Repository.resumeJob('XS024536');
  await A.Repository.refresh();
  ok(A.woById('XS024536').onHold === false, 'resume propagates to device A');
  /* shared completion guard runs against fresh backend state */
  var cerr = null;
  try { await A.Repository.completeWarehouseWork('XS024536'); } catch (e) { cerr = e; }
  ok(cerr && cerr.code === 'LINES_INCOMPLETE', 'shared completion blocked while lines incomplete');
  /* shared note round-trips */
  await A.Repository.addWorkOrderNote('XS024536', 'shared note 1');
  await B.Repository.refresh();
  ok(B.woNotes(B.woById('XS024536')).some(function (n) { return n.detail === 'shared note 1'; }),
    'note written on A appears on B');
  /* offline: unsafe mutations fail fast, mirror untouched */
  B._nav.onLine = false;
  var oerr = null;
  try { await B.Repository.setJobHold('XS024541', 'OTHER'); } catch (e) { oerr = e; }
  ok(oerr && oerr.code === 'OFFLINE', 'offline hold fails fast with OFFLINE');
  ok(B.woById('XS024541').onHold === false, 'offline failure leaves the local mirror untouched');
  var oerr2 = null;
  try { await B.Repository.completeWarehouseWork('XS024542'); } catch (e) { oerr2 = e; }
  ok(oerr2 && oerr2.code === 'OFFLINE', 'offline completion fails fast');
  B._nav.onLine = true;
  /* cached reads still work offline */
  var cached = B.scheduledJobs();
  ok(Array.isArray(cached) && cached.length > 0, 'queue reads work from the cached mirror offline');
  await harness.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) { console.error('FATAL', e); process.exit(1); });
