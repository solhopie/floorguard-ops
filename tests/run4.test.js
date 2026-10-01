/* FloorGuard Ops — Run 4 shared-backend assertions.
   Run: node tests/run4.test.js
   Starts tests/postgrest-double.js (in-memory PostgREST + RPC + Storage +
   Auth implementing the backend contract), loads app.js + repository.js into
   one vm sandbox per simulated "device", and covers the Run 4 test list:
   migration files, provider modes, atomic cuts, version conflicts,
   idempotency, two-device sync, offline queueing, cycle counts, history
   cards, import, and local-data preservation. */
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var dbl = require('./postgrest-double.js');

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

/* ---------- per-device sandbox ---------- */
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
  var sandbox = {
    console: console,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
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
    navigator: { vibrate: function () {}, onLine: true }
  };
  vm.createContext(sandbox);
  var appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  var bootIdx = appSrc.lastIndexOf('/* ---------------- boot');
  vm.runInContext(appSrc.slice(0, bootIdx), sandbox, { filename: 'app.js' });
  var repoSrc = fs.readFileSync(path.join(__dirname, '..', 'repository.js'), 'utf8');
  vm.runInContext(repoSrc, sandbox, { filename: 'repository.js' });
  sandbox.DB.reset();
  sandbox.DB.data.currentEmployee = 'Marcus';
  sandbox._elFor = elFor;
  return sandbox;
}
function sharedConfig(D, base) {
  D.Repository.saveConfig({
    dataProvider: 'shared', supabaseUrl: base,
    supabaseAnonKey: 'test-anon-key', warehouseId: 'main'
  });
}

async function main() {
  var harness = dbl.startDouble();
  var base = await harness.start();
  var st = harness.state;

  /* ===== A. migration files ===== */
  var migDir = path.join(__dirname, '..', 'supabase', 'migrations');
  ['0001_core.sql', '0002_operations.sql', '0003_history_docs.sql',
   '0004_rls.sql', '0005_cycle_count_rpc.sql'].forEach(function (f) {
    ok(fs.existsSync(path.join(migDir, f)), 'migration exists: ' + f);
  });
  ok(fs.existsSync(path.join(__dirname, '..', 'supabase', 'seed.sql')), 'seed.sql exists');
  var m1 = fs.readFileSync(path.join(migDir, '0001_core.sql'), 'utf8');
  var m2 = fs.readFileSync(path.join(migDir, '0002_operations.sql'), 'utf8');
  var m4 = fs.readFileSync(path.join(migDir, '0004_rls.sql'), 'utf8');
  var m5 = fs.readFileSync(path.join(migDir, '0005_cycle_count_rpc.sql'), 'utf8');
  ok(/create table public\.rolls/.test(m1), '0001 creates rolls');
  ok(/expected_in\s+integer not null/.test(m1), 'balances are integer inches');
  ok(/version\s+integer not null default 1/.test(m1), 'rolls carry an optimistic version');
  ok(/record_cut/.test(m2) && /ROLL_VERSION_CONFLICT/.test(m2), '0002: atomic record_cut with version conflicts');
  ok(/reserve_inventory/.test(m2), '0002: atomic reserve_inventory');
  ok(/enable row level security/.test(m4), '0004 enables RLS');
  ok(/history-cards/.test(m4), '0004 provisions the private history-cards bucket');
  ok(/record_cycle_count/.test(m5), '0005: atomic record_cycle_count');
  ok(!/version = version \+ 1|version \+ 1/.test(m5), '0005: measurements do not bump the optimistic version');
  var repoSrc = fs.readFileSync(path.join(__dirname, '..', 'repository.js'), 'utf8');
  ok(!/service_role/i.test(repoSrc), 'no service-role key in repository.js');
  ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(repoSrc), 'no hardcoded JWT in repository.js');
  ok(repoSrc.indexOf('supabase.co') < 0, 'no hardcoded Supabase URL in repository.js');

  /* ===== B. provider modes ===== */
  var D = makeDevice();
  ok(D.Repository.mode === 'local', 'default provider is local');
  ok(D.dataMode() === 'local', 'app dataMode() defaults to local');
  D.Repository.saveConfig({ dataProvider: 'shared' });
  ok(D.Repository.mode === 'local', 'shared without URL+key falls back to local');
  sharedConfig(D, base);
  ok(D.Repository.mode === 'shared', 'shared engages with URL + anon key');
  /* unauthenticated write is rejected */
  var unauthErr = null;
  try { await D.SharedRepo.recordCut({ rollId: '16628697', order: 'X', cutIn: 10, employee: 'Marcus', warehouseId: 'main', expectedVersion: null, clientRequestId: 'CR-UNAUTH' }); }
  catch (e) { unauthErr = e; }
  ok(unauthErr && unauthErr.code === 'NOT_AUTHENTICATED', 'unauthenticated cut is rejected');
  await D.Repository.signIn('marcus@warehouse.com', 'pw');
  ok(D.Repository.session() && D.Repository.session().email === 'marcus@warehouse.com', 'shared sign-in stores a session');

  /* ===== C. atomic cut on device A (explicit versions via SharedRepo) ===== */
  await D.Repository.refresh();
  ok(D.systemBalance('16628697') === 1034, 'hydrated balance is the backend balance (1034)');
  var r1 = await D.SharedRepo.recordCut({
    rollId: '16628697', order: 'XS024536', cutIn: 237, employee: 'Marcus',
    location: '205B', warehouseId: 'main', expectedVersion: 1, clientRequestId: 'CR-A1'
  });
  ok(r1.ok && !r1.duplicate && r1.cutId, 'device A cut succeeds');
  ok(r1.newBalanceIn === 797 && r1.newVersion === 2, 'RPC returns the new balance + version');
  await D.Repository.refresh();
  ok(D.systemBalance('16628697') === 797, 'device A sees 797 after the cut');
  ok(st.tables.cut_transactions.size === 1, 'exactly one cut row in the backend');
  ok(st.tables.history_events.size >= 1, 'CUT history event recorded');
  ok(st.tables.audit_events.size >= 1, 'CUT audit event recorded');
  var cutRow = Array.from(st.tables.cut_transactions.values())[0];
  ok(cutRow.balance_before_in === 1034 && cutRow.balance_after_in === 797, 'cut row carries before/after balances');

  /* idempotent retry: same request id, same params */
  var rDup = await D.SharedRepo.recordCut({
    rollId: '16628697', order: 'XS024536', cutIn: 237, employee: 'Marcus',
    location: '205B', warehouseId: 'main', expectedVersion: 1, clientRequestId: 'CR-A1'
  });
  ok(rDup.ok && rDup.duplicate === true, 'same request id replays as duplicate');
  ok(st.tables.cut_transactions.size === 1, 'retry does not duplicate the cut row');
  ok(st.tables.rolls.get('16628697').expected_in === 797, 'retry does not move the balance again');

  /* insufficient balance (current version, so the quantity check is the one that fires) */
  var balErr = null;
  try {
    await D.SharedRepo.recordCut({ rollId: '16628698', order: 'X', cutIn: 9999,
      employee: 'Marcus', warehouseId: 'main', expectedVersion: 1, clientRequestId: 'CR-BIG' });
  } catch (e) { balErr = e; }
  ok(balErr && balErr.code === 'INSUFFICIENT_BALANCE', 'oversized cut is refused');
  ok(st.tables.rolls.get('16628698').expected_in === 366, 'refused cut leaves the balance untouched');

  /* ===== D. two-device sync: stale device must not overwrite ===== */
  var B = makeDevice();
  sharedConfig(B, base);
  await B.Repository.signIn('ana@warehouse.com', 'pw');
  await B.Repository.refresh(); /* B sees version 2 / 797 */
  var bRoll = B.rollById('16628697');
  ok(bRoll.sharedVersion === 2 && bRoll.sharedExpectedIn === 797, 'device B hydrates the post-cut state');
  /* A cuts again (version 2 -> 3) while B holds its screen */
  var rA2 = await D.SharedRepo.recordCut({ rollId: '16628697', order: 'X2', cutIn: 100,
    employee: 'Marcus', warehouseId: 'main', expectedVersion: 2, clientRequestId: 'CR-A2' });
  ok(rA2.ok && st.tables.rolls.get('16628697').expected_in === 697, 'device A second cut lands (697)');
  /* B submits with its stale screen version */
  var conflict = null;
  try {
    await B.SharedRepo.recordCut({ rollId: '16628697', order: 'XB', cutIn: 50,
      employee: 'Ana', warehouseId: 'main', expectedVersion: 2, clientRequestId: 'CR-B1' });
  } catch (e) { conflict = e; }
  ok(conflict && conflict.code === 'ROLL_VERSION_CONFLICT', 'stale device gets ROLL_VERSION_CONFLICT');
  ok(conflict.data && conflict.data.current_balance_in === 697 && conflict.data.current_version === 3,
    'conflict carries the current backend balance + version');
  ok(st.tables.rolls.get('16628697').expected_in === 697, 'stale write did not overwrite inventory');
  ok(st.tables.cut_transactions.size === 2, 'no cut row was inserted by the stale attempt');
  /* B refreshes and continues with the fresh balance */
  await B.Repository.refresh();
  ok(B.systemBalance('16628697') === 697, 'device B sees the current balance after refresh');
  var rB = await B.SharedRepo.recordCut({ rollId: '16628697', order: 'XB', cutIn: 50,
    employee: 'Ana', warehouseId: 'main', expectedVersion: 3, clientRequestId: 'CR-B2' });
  ok(rB.ok, 'device B cut succeeds on the fresh version');
  await B.Repository.refresh();
  ok(B.systemBalance('16628697') === 647, 'device B sees 647 after its cut');

  /* ===== E. reservations: atomic consume + legal transitions ===== */
  var ra = await B.SharedRepo.assignInventory({
    workOrderId: 'XS024536', lineId: 'XS024536-L1', rollId: '16628698',
    reservedIn: 200, employee: 'Ana', warehouseId: 'main',
    expectedVersion: 1, clientRequestId: 'AR-B1'
  });
  ok(ra.ok && ra.assignmentId, 'reserve_inventory succeeds');
  ok(st.tables.inventory_assignments.get(ra.assignmentId).status === 'RESERVED', 'assignment is RESERVED');
  var rc = await B.SharedRepo.recordCut({ rollId: '16628698', order: 'XS024536', cutIn: 100,
    employee: 'Ana', warehouseId: 'main', assignmentId: ra.assignmentId,
    expectedVersion: 1, clientRequestId: 'CR-B3' });
  ok(rc.ok, 'cut against the reservation succeeds');
  var aRow = st.tables.inventory_assignments.get(ra.assignmentId);
  ok(aRow.status === 'CONSUMED' && aRow.actual_cut_in === 100, 'cut atomically consumes the reservation');
  ok(st.tables.rolls.get('16628698').expected_in === 266, 'balance reflects the cut (266)');
  /* illegal reverse transition */
  var transErr = null;
  try { await B.SharedRepo._patch('inventory_assignments', 'id=eq.' + ra.assignmentId, { status: 'RESERVED' }); }
  catch (e) { transErr = e; }
  ok(transErr !== null, 'CONSUMED -> RESERVED transition is rejected');
  ok(st.tables.inventory_assignments.get(ra.assignmentId).status === 'CONSUMED', 'illegal transition leaves state intact');
  /* release path */
  var ra2 = await B.SharedRepo.assignInventory({ workOrderId: 'XS024537', lineId: null,
    rollId: '16628698', reservedIn: 50, employee: 'Ana', warehouseId: 'main',
    expectedVersion: 2, clientRequestId: 'AR-B2' });
  var rel = await B.SharedRepo.releaseInventory(ra2.assignmentId, 'Ana');
  ok(rel.ok && st.tables.inventory_assignments.get(ra2.assignmentId).status === 'RELEASED', 'release moves RESERVED -> RELEASED');

  /* ===== F. cycle counts never move trusted balances ===== */
  var verBefore = st.tables.rolls.get('16628697').version; /* 4 */
  var cc = await B.SharedRepo.recordCycleCount({ rollId: '16628697', scannedLocation: '205B',
    expectedIn: 647, physicalIn: 640, status: 'SHORT', employee: 'Ana', warehouseId: 'main' });
  ok(cc.ok && cc.diffIn === -7, 'cycle count records with a diff');
  var rollAfter = st.tables.rolls.get('16628697');
  ok(rollAfter.expected_in === 647, 'count does not change the expected balance');
  ok(rollAfter.measured_in === 640 && rollAfter.measured_by === 'Ana', 'MB stamp recorded');
  ok(rollAfter.version === verBefore, 'count does not bump the optimistic version');
  ok(st.tables.history_events.size >= 3, 'PHYSICAL_MEASUREMENT history recorded');
  /* an in-flight cut with the pre-count version still succeeds */
  var rc2 = await B.SharedRepo.recordCut({ rollId: '16628697', order: 'XC', cutIn: 10,
    employee: 'Ana', warehouseId: 'main', expectedVersion: verBefore, clientRequestId: 'CR-B4' });
  ok(rc2.ok && st.tables.rolls.get('16628697').expected_in === 637, 'in-flight cut survives the measurement');

  /* ===== G. offline: never pretend success, explicit retry ===== */
  await B.Repository.refresh(); /* B is current again: 637 / version 5 */
  B.navigator.onLine = false;
  var offErr = null;
  try {
    await B.SharedFlow.recordCut({ rollId: '16628697', order: 'XO', cutIn: 5,
      employee: 'Ana', location: '205B', warehouseId: 'main', clientRequestId: 'CR-OFF' });
  } catch (e) { offErr = e; }
  ok(offErr && offErr.code === 'OFFLINE', 'offline cut rejects with OFFLINE');
  ok(offErr && offErr.code === 'OFFLINE', 'offline cut rejects with OFFLINE');
  var cutsNow = st.tables.cut_transactions.size;
  B.Sync.queue({ kind: 'cut', payload: { rollId: '16628697', order: 'XO', cutIn: 5,
    employee: 'Ana', location: '205B', warehouseId: 'main', clientRequestId: 'CR-OFF' } });
  ok(B.Sync.outbox().length === 1, 'offline cut is queued, not lost');
  ok(B.Sync.state === 'OFFLINE', 'sync state drops to OFFLINE');
  ok(typeof B.retryOutboxCuts === 'function', 'explicit retry entry point exists');
  B.navigator.onLine = true;
  /* explicit retry, same request id -> exactly one cut */
  var item = B.Sync.outbox()[0];
  var rr = await B.SharedFlow.recordCut(item.payload);
  B.Sync.dequeue(item.id);
  ok(rr.ok && !rr.duplicate && B.Sync.outbox().length === 0, 'explicit retry syncs the queued cut exactly once');
  ok(st.tables.cut_transactions.size === cutsNow + 1, 'one new cut row after retry');
  var rr2 = await B.SharedFlow.recordCut({ rollId: '16628697', order: 'XO', cutIn: 5,
    employee: 'Ana', location: '205B', warehouseId: 'main', clientRequestId: 'CR-OFF' });
  ok(rr2.duplicate === true, 'retrying the same request id is a duplicate, not a new cut');
  ok(st.tables.cut_transactions.size === cutsNow + 1, 'still exactly one new cut row');

  /* ===== H. sync states ===== */
  B.Sync.set('SYNCING');
  ok(B.Sync.state === 'SYNCING', 'sync state SYNCING');
  B.Sync.set('SYNCED');
  B.updateSyncIndicator();
  ok(B._elFor('sync').className.indexOf('s-synced') >= 0, 'topbar dot reflects SYNCED');
  B.Sync.set('OFFLINE');
  B.updateSyncIndicator();
  ok(B._elFor('sync').className.indexOf('s-offline') >= 0, 'topbar dot reflects OFFLINE');
  B.Sync.set('SYNCED');

  /* ===== I. local mode untouched + local data preserved across switching ===== */
  var L = makeDevice(); /* stays local */
  var cutsBeforeLocal = L.FG().cuts.length;
  var lres = L.CutService.recordCut({ rollId: '16628697', order: 'LOCAL1', cutIn: 34,
    employee: 'Marcus', location: '205B' });
  ok(lres.ok && L.systemBalance('16628697') === 1000, 'local cut still synchronous and exact (1034-34)');
  ok(L.FG().cuts.length === cutsBeforeLocal + 1, 'local cut appended locally');
  sharedConfig(L, base);
  ok(L.Repository.mode === 'shared', 'device switches to shared');
  ok(L.FG().cuts.length === cutsBeforeLocal + 1 &&
     L.FG().cuts[L.FG().cuts.length - 1].order === 'LOCAL1',
     'local data preserved when switching providers');
  L.Repository.saveConfig({ dataProvider: 'local' });
  ok(L.Repository.mode === 'local' && L.FG().cuts[L.FG().cuts.length - 1].order === 'LOCAL1',
     'switching back keeps local data');

  /* ===== J. explicit import: idempotent, never overwrites ===== */
  sharedConfig(L, base); /* back to shared for the import; local data stays on the device */
  var snap = L.Repository.exportLocal();
  var localCut = (snap.cuts || []).filter(function (c) { return c.order === 'LOCAL1'; })[0];
  ok(snap.rolls.length > 0 && !!localCut, 'exportLocal captures rolls + the local cut');
  await L.Repository.signIn('marcus@warehouse.com', 'pw');
  var imp1 = await L.Repository.importShared(snap);
  ok(imp1.ok, 'import succeeds');
  var sharedRoll = st.tables.rolls.get('16628697');
  ok(sharedRoll.expected_in === 598, 'import replays the local cut on the pristine base: 632 - 34 = 598 (no double-subtract)');
  var imp2 = await L.Repository.importShared(snap);
  ok(imp2.ok && imp2.summary.skipped > 0, 're-import skips existing records');
  ok(st.tables.rolls.get('16628697').expected_in === 598, 're-import does not move the balance again');

  /* ===== K. history cards: private storage, no overwrite ===== */
  var tinyJpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  var hc1 = await B.SharedRepo.uploadHistoryCard({ rollId: '16628697', imageDataUrl: tinyJpg,
    mimeType: 'image/jpeg', employee: 'Ana', warehouseId: 'main' });
  ok(hc1.ok && hc1.doc && hc1.doc.id, 'history card upload succeeds');
  var docRow = st.tables.documents.get(hc1.doc.id);
  ok(docRow && docRow.storage_path.indexOf('main/16628697/') === 0, 'storage path is namespaced <warehouse>/<roll>/<file>');
  ok(docRow.storage_path.indexOf('history-cards/history-cards') < 0, 'storage path is bucket-relative (no double prefix)');
  var storedBytes = st.storage['history-cards/' + docRow.storage_path];
  ok(storedBytes && storedBytes.length === 4, 'original bytes land in private storage');
  var hc2 = await B.SharedRepo.uploadHistoryCard({ rollId: '16628697', imageDataUrl: tinyJpg,
    mimeType: 'image/jpeg', employee: 'Ana', warehouseId: 'main' });
  ok(hc2.doc.id !== hc1.doc.id, 'second upload gets its own document id');
  ok(st.storage['history-cards/' + st.tables.documents.get(hc2.doc.id).storage_path].length === 4,
    'second upload gets its own storage object (originals are never overwritten)');
  /* extraction confirm: history only, balances untouched */
  var balBeforeX = st.tables.rolls.get('16628697').expected_in;
  var xi = await B.SharedRepo.confirmHistoryImport({ docId: hc1.doc.id, rollId: '16628697',
    fields: { job: 'J1' }, employee: 'Ana', warehouseId: 'main' });
  ok(xi.ok, 'extraction confirm succeeds');
  ok(st.tables.rolls.get('16628697').expected_in === balBeforeX, 'extraction never changes the trusted balance');
  var impRow = Array.from(st.tables.history_card_imports.values())[0];
  ok(impRow && impRow.status === 'CONFIRMED', 'import row is CONFIRMED');

  /* ===== L. hydrate maps imports onto documents ===== */
  await B.Repository.refresh();
  var bDoc = B.FG().documents.filter(function (d) { return d.id === hc1.doc.id; })[0];
  ok(bDoc && bDoc.imports && bDoc.imports.length === 1 && bDoc.imports[0].fields.job === 'J1',
    'hydrated document carries its confirmed import');

  /* ===== M. shared-mode document numbering (regression: doc screen showed
     "HISTORY CARD #undefined") ===== */
  var bDocs = B.FG().documents.filter(function (d) { return d.rollId === '16628697' && d.kind === 'HISTORY_CARD'; });
  ok(bDocs.length === 2, 'both history cards hydrate onto the roll');
  var nums = bDocs.map(function (d) { return d.num; }).sort();
  ok(nums[0] === 1 && nums[1] === 2, 'hydrated history cards get per-roll sequence numbers 1,2 (oldest first)');
  ok(bDocs.every(function (d) { return typeof d.num === 'number'; }),
    'no hydrated history card renders "HISTORY CARD #undefined"');
  var rcptDocRow = { id: 'DTEST1', roll_id: null, receipt_id: 'RCV-1', warehouse_id: 'main',
    storage_path: 'main/receipts/RCV-1/RD1.jpg', document_type: 'RECEIVING DOCUMENT',
    employee_name: 'Ana', captured_at: new Date().toISOString() };
  var rcptDoc = B.Mappers.rowToDocument(rcptDocRow);
  ok(rcptDoc.kind === 'RECEIPT_DOCUMENT' && rcptDoc.source === 'PAPER CARD',
    'rowToDocument maps receipt docs with accurate PAPER CARD source');
  ok(bDoc.source === 'PAPER CARD', 'hydrated history cards carry the PAPER CARD source label');

  await harness.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) { console.error('RUN4 HARNESS ERROR:', e); process.exit(1); });
