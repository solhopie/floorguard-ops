/* FloorGuard Ops — Run 8 returns + disposition assertions.
   Run: node tests/run8.test.js
   Covers: schema-7 migration, local return numbering (RET-/REM-),
   idempotency, role gating (employee/supervisor/manager), offline
   fail-fast, restock balance changes + version increments + stale-version
   rejection, remnant parent-balance preservation, quarantine assignment
   exclusion, scrap/vendor manager restriction, return documents, shared
   two-device flows through the PostgREST double (backend numbering,
   idempotent retries, server-side authorization via simulated roles,
   stale roll versions, multi-device sync), and integrations
   (WO/SO/loadout linkage, roll ledger, dashboard).
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
function setRole(D, role) {
  D.DB.data.employeeRoles = D.DB.data.employeeRoles || {};
  D.DB.data.employeeRoles[D.DB.data.currentEmployee] = role;
}
async function rejectsCode(p, code) {
  try { await p; } catch (e) { return e && e.code === code; }
  return false;
}
async function rejectsLocal(fn, err) {
  try { var r = fn(); } catch (e) { return e && e.message === err; }
  return r && r.ok === false && (r.err === err || r.error === err);
}

async function main() {
  /* ================= A. schema 7 + migration ================= */
  var S = makeDevice();
  ok(S.DB.data.schema === 7, 'seed schema is 7');
  ok(Array.isArray(S.FG().returns) && Array.isArray(S.FG().returnItems) &&
     Array.isArray(S.FG().returnDispositions) && Array.isArray(S.FG().returnedRemnants) &&
     Array.isArray(S.FG().returnExceptions),
    'seed carries return collections');
  ok(S.FG().seq.return >= 100001 && S.FG().seq.remnant >= 100001,
    'seed seeds return/remnant counters at 100001');
  /* v6 -> v7 migration path */
  var M = makeDevice();
  var mfg = M.FG();
  delete mfg.returns; delete mfg.returnItems; delete mfg.returnDispositions;
  delete mfg.returnedRemnants; delete mfg.returnExceptions;
  mfg.seq.return = 0; mfg.seq.remnant = 0;
  M.migrateFloorguardV6toV7();
  ok(Array.isArray(mfg.returns) && Array.isArray(mfg.returnedRemnants) &&
     mfg.seq.return >= 100001 && mfg.seq.remnant >= 100001,
    'v6->v7 migration creates collections and reseeds counters above fixtures');

  /* ================= B. local numbering + idempotency ================= */
  var N = makeDevice();
  setRole(N, 'SUPERVISOR');
  var r1 = N.createReturnLocal({ reason: 'DEFECTIVE', requestKey: 'rk-1' });
  var r1dup = N.createReturnLocal({ reason: 'DEFECTIVE', requestKey: 'rk-1' });
  ok(r1.ok && /^RET-100001$/.test(r1.return.number), 'first return is RET-100001: ' + (r1.return && r1.return.number));
  ok(r1dup.ok && r1dup.duplicate && r1dup.return.id === r1.return.id,
    'retry with same request key returns the original (idempotent)');
  var r2 = N.createReturnLocal({ reason: 'WRONG_ITEM', requestKey: 'rk-2' });
  ok(r2.ok && r2.return.number === 'RET-100002', 'second return is RET-100002');

  /* ================= C. local role gating ================= */
  var E = makeDevice();
  setRole(E, 'WAREHOUSE_EMPLOYEE');
  var er = E.createReturnLocal({ reason: 'DEFECTIVE', requestKey: 'erk-1' });
  ok(er.ok, 'employee can create a return');
  var eit = E.addReturnItemLocal(er.return.id, { materialType: 'CARPET', requestKey: 'eik-1' });
  ok(eit.ok, 'employee can add a return item');
  var eme = E.measureReturnItemLocal(eit.item.id, 138, { requestKey: 'emk-1' });
  ok(eme.ok, 'employee can measure a return item');
  var ein = E.inspectReturnItemLocal(eit.item.id, 'GOOD', {});
  ok(ein.ok, 'employee can inspect a return item');
  var erstock = await rejectsLocal(function () {
    return E.approveRestockLocal(eit.item.id, { rollId: '16628697' });
  }, 'RESTOCK APPROVAL REQUIRES A SUPERVISOR OR ABOVE');
  ok(erstock, 'employee restock approval is rejected (supervisor+)');
  var escrap = await rejectsLocal(function () {
    return E.scrapReturnItemLocal(eit.item.id, {});
  }, 'SCRAP AUTHORIZATION REQUIRES A MANAGER OR ADMIN');
  ok(escrap, 'employee scrap is rejected (manager+)');

  /* ================= D. local restock: balance + version ================= */
  var V = makeDevice();
  setRole(V, 'SUPERVISOR');
  var vr = V.createReturnLocal({ reason: 'OVERAGE', workOrderId: 'XS024536', requestKey: 'vrk-1' });
  var vit = V.addReturnItemLocal(vr.return.id, { materialType: 'CARPET', rollId: '16628697', requestKey: 'vik-1' });
  V.measureReturnItemLocal(vit.item.id, 138, { requestKey: 'vmk-1' });
  V.inspectReturnItemLocal(vit.item.id, 'GOOD', {});
  var rollBefore = V.rollById('16628697');
  var balBefore = V.systemBalance('16628697');
  var verBefore = rollBefore.version || 1;
  var rs = V.approveRestockLocal(vit.item.id, { rollId: '16628697', requestKey: 'vrsk-1' });
  ok(rs.ok && !rs.duplicate, 'supervisor restock succeeds');
  var balAfter = V.systemBalance('16628697');
  ok(balAfter === balBefore + 138, 'restock increases balance by measured inches: ' + balBefore + ' -> ' + balAfter);
  ok(V.rollById('16628697').version === verBefore + 1, 'restock increments roll version');
  ok(rs.newBalanceIn === balAfter, 'restock result carries the new balance');
  /* idempotent retry */
  var rsdup = V.approveRestockLocal(vit.item.id, { rollId: '16628697', requestKey: 'vrsk-1' });
  ok(rsdup.ok && rsdup.duplicate && V.systemBalance('16628697') === balAfter,
    'restock retry is idempotent (no double-apply)');
  /* stale version */
  var vr2 = V.createReturnLocal({ reason: 'OVERAGE', requestKey: 'vrk-2' });
  var vit2 = V.addReturnItemLocal(vr2.return.id, { rollId: '16628697', requestKey: 'vik-2' });
  V.measureReturnItemLocal(vit2.item.id, 50, {});
  V.inspectReturnItemLocal(vit2.item.id, 'GOOD', {});
  var stale = await rejectsLocal(function () {
    return V.approveRestockLocal(vit2.item.id, { rollId: '16628697', rollVersion: verBefore, requestKey: 'vrsk-2' });
  }, 'ROLL_VERSION_CONFLICT');
  ok(stale, 'stale roll version is rejected');

  /* ================= E. local remnant: independent identity ================= */
  var Q = makeDevice();
  setRole(Q, 'SUPERVISOR');
  var qr = Q.createReturnLocal({ reason: 'DAMAGED', requestKey: 'qrk-1' });
  var qit = Q.addReturnItemLocal(qr.return.id, { rollId: '16628697', requestKey: 'qik-1' });
  Q.measureReturnItemLocal(qit.item.id, 60, {});
  Q.inspectReturnItemLocal(qit.item.id, 'DAMAGED', {});
  var qbalBefore = Q.systemBalance('16628697');
  var qm = Q.createReturnedRemnantLocal(qit.item.id, { lengthIn: 60, requestKey: 'qmk-1' });
  ok(qm.ok && /^REM-100001$/.test(qm.remnant.number), 'first remnant is REM-100001: ' + (qm.remnant && qm.remnant.number));
  ok(Q.systemBalance('16628697') === qbalBefore, 'remnant creation does NOT change parent balance');
  ok(qm.remnant.parentRollId === '16628697' && qm.remnant.status === 'AVAILABLE',
    'remnant links parent roll and is AVAILABLE');
  var qavail = Q.availableReturnedRemnants();
  ok(qavail.length === 1 && qavail[0].id === qm.remnant.id, 'remnant appears in available inventory');
  /* damaged condition cannot restock into trusted roll */
  var qr2 = Q.createReturnLocal({ reason: 'DAMAGED', requestKey: 'qrk-2' });
  var qit2 = Q.addReturnItemLocal(qr2.return.id, { rollId: '16628697', requestKey: 'qik-2' });
  Q.measureReturnItemLocal(qit2.item.id, 40, {});
  Q.inspectReturnItemLocal(qit2.item.id, 'DAMAGED', {});
  var qbad = await rejectsLocal(function () {
    return Q.approveRestockLocal(qit2.item.id, { rollId: '16628697', requestKey: 'qmk-9' });
  }, 'CONDITION NOT RESTOCKABLE');
  ok(qbad, 'damaged material cannot merge into a trusted roll');

  /* ================= E2. submit transitions to READY_FOR_DISPOSITION ================= */
  var SR = makeDevice();
  var srr = SR.createReturnLocal({ reason: 'OVERAGE', requestKey: 'srrk-1' });
  var srit = SR.addReturnItemLocal(srr.return.id, { requestKey: 'srrik-1' });
  SR.measureReturnItemLocal(srit.item.id, 50, {});
  SR.inspectReturnItemLocal(srit.item.id, 'GOOD', {});
  var srsub = SR.submitReturnLocal(srr.return.id);
  ok(srsub.ok && srsub.return.status === 'READY_FOR_DISPOSITION', 'submit moves return to READY_FOR_DISPOSITION');
  /* submit from RECEIVED status (receive first, then submit) */
  var SR2 = makeDevice();
  var srr2 = SR2.createReturnLocal({ reason: 'OVERAGE', requestKey: 'srrk-2' });
  SR2.receiveReturnLocal(srr2.return.id, {});
  var srit2 = SR2.addReturnItemLocal(srr2.return.id, { requestKey: 'srrik-2' });
  SR2.measureReturnItemLocal(srit2.item.id, 50, {});
  SR2.inspectReturnItemLocal(srit2.item.id, 'GOOD', {});
  var srsub2 = SR2.submitReturnLocal(srr2.return.id);
  ok(srsub2.ok && srsub2.return.status === 'READY_FOR_DISPOSITION', 'submit works from RECEIVED status');
  /* submit idempotency: second submit returns duplicate */
  var srsub3 = SR2.submitReturnLocal(srr2.return.id);
  ok(srsub3.ok && srsub3.duplicate === true, 'resubmitting a submitted return is idempotent');
  /* submit rejects COMPLETED returns */
  var SR3 = makeDevice();
  var srr3 = SR3.createReturnLocal({ reason: 'OVERAGE', requestKey: 'srrk-3' });
  SR3.FG().returns.filter(function (x) { return x.id === srr3.return.id; })[0].status = 'COMPLETED';
  var srsub4 = SR3.submitReturnLocal(srr3.return.id);
  ok(!srsub4.ok && srsub4.err === 'INVALID STATUS', 'submit rejects COMPLETED returns');

  /* ================= F. quarantine excludes from assignment ================= */
  var W = makeDevice();
  setRole(W, 'SUPERVISOR');
  var wr = W.createReturnLocal({ reason: 'DEFECTIVE', requestKey: 'wrk-1' });
  var wit = W.addReturnItemLocal(wr.return.id, { rollId: '16628697', requestKey: 'wik-1' });
  W.inspectReturnItemLocal(wit.item.id, 'DEFECTIVE', {});
  var wq = W.quarantineReturnItemLocal(wit.item.id, { reason: 'suspected water damage', requestKey: 'wqk-1' });
  ok(wq.ok && wq.holding && wq.holding.status === 'QUARANTINED', 'quarantine creates a QUARANTINED holding');
  var wavail = W.availableReturnedRemnants();
  ok(wavail.length === 0, 'quarantined material is not available for assignment');

  /* ================= G. scrap/vendor need manager ================= */
  var G = makeDevice();
  setRole(G, 'SUPERVISOR');
  var gr = G.createReturnLocal({ reason: 'DEFECTIVE', requestKey: 'grk-1' });
  var git = G.addReturnItemLocal(gr.return.id, { rollId: '16628697', requestKey: 'gik-1' });
  G.inspectReturnItemLocal(git.item.id, 'DEFECTIVE', {});
  var gscrap = await rejectsLocal(function () { return G.scrapReturnItemLocal(git.item.id, {}); }, 'SCRAP AUTHORIZATION REQUIRES A MANAGER OR ADMIN');
  ok(gscrap, 'supervisor scrap is rejected (manager+)');
  setRole(G, 'MANAGER');
  var gscrap2 = G.scrapReturnItemLocal(git.item.id, { reason: 'beyond repair', requestKey: 'gsk-1' });
  ok(gscrap2.ok, 'manager scrap succeeds');
  var git2 = G.addReturnItemLocal(gr.return.id, { rollId: '16628697', requestKey: 'gik-2' });
  G.inspectReturnItemLocal(git2.item.id, 'DEFECTIVE', {});
  var gvend = G.sendReturnToVendorLocal(git2.item.id, { supplier: 'Acme', requestKey: 'gvk-1' });
  ok(gvend.ok, 'manager vendor return succeeds');

  /* ================= H. return documents ================= */
  var D = makeDevice();
  setRole(D, 'WAREHOUSE_EMPLOYEE');
  var dr = D.createReturnLocal({ reason: 'OTHER', notes: 'customer changed mind', requestKey: 'drk-1' });
  var tinyImg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  var ddoc = await D.Repository.uploadReturnDocument({ returnId: dr.return.id,
    imageDataUrl: tinyImg, thumbDataUrl: tinyImg, employee: 'Marcus' });
  ok(ddoc.ok && ddoc.doc.returnId === dr.return.id && ddoc.doc.kind === 'RETURN_DOCUMENT',
    'local return document links returnId');
  var ddocs = await D.Repository.getDocumentsForReturn(dr.return.id);
  ok(ddocs.length >= 1 && ddocs[0].returnId === dr.return.id,
    'local getDocumentsForReturn returns the captured document');

  /* ================= I. shared: numbering + idempotency + auth ================= */
  var harness = dbl.startDouble();
  var base = await harness.start();
  var A = makeDevice(); sharedConfig(A, base);
  var B = makeDevice(); sharedConfig(B, base);
  A.DB.data.currentEmployee = 'alice@warehouse.com';
  B.DB.data.currentEmployee = 'bob@warehouse.com';
  await A.Repository.signIn('alice@warehouse.com', 'pw');
  await B.Repository.signIn('bob@warehouse.com', 'pw');
  /* server-side roles in the double */
  harness.setRole('alice@warehouse.com', 'SUPERVISOR');
  harness.setRole('bob@warehouse.com', 'WAREHOUSE_EMPLOYEE');
  setRole(A, 'SUPERVISOR');
  setRole(B, 'WAREHOUSE_EMPLOYEE');

  var sa = await A.Repository.createReturn({ reason: 'OVERAGE', requestKey: 'shk-1' });
  ok(sa.ok && /^RET-100001$/.test(sa.return.number), 'shared first return is RET-100001');
  var saDup = await A.Repository.createReturn({ reason: 'OVERAGE', requestKey: 'shk-1' });
  ok(saDup.ok && saDup.duplicate && saDup.return.id === sa.return.id,
    'shared create retry is idempotent');
  var sb = await B.Repository.createReturn({ reason: 'DEFECTIVE', requestKey: 'shk-2' });
  ok(sb.ok && sb.return.number === 'RET-100002', 'second device gets RET-100002 (central numbering)');

  /* employee adds/measures/inspects on device B */
  var sbi = await B.Repository.addReturnItem(sb.return.id, { materialType: 'CARPET', requestKey: 'shik-1' });
  ok(sbi.ok, 'shared add item (employee)');
  await B.Repository.measureReturnItem(sbi.item.id, 100);
  await B.Repository.inspectReturnItem(sbi.item.id, 'GOOD');
  /* B needs a roll to restock into — use the shared roll from fixtures */
  await B.Repository.refresh();
  var sroll = (B.FG().rolls || [])[0];
  ok(!!sroll, 'shared device has rolls after refresh');
  /* employee restock must fail on the SERVER (double enforces role).
     Temporarily lift the client-side gate so the request reaches the server. */
  setRole(B, 'SUPERVISOR');
  var empRestockDenied = await rejectsCode(
    B.Repository.approveRestock(sbi.item.id, { rollId: sroll.id, requestKey: 'shrk-1' }), 'NOT_AUTHORIZED');
  setRole(B, 'WAREHOUSE_EMPLOYEE');
  ok(empRestockDenied, 'server rejects employee restock with NOT_AUTHORIZED');
  /* supervisor restock succeeds; balance changes; version increments */
  await A.Repository.refresh();
  var aroll = A.FG().rolls.filter(function (r) { return r.id === sroll.id; })[0];
  var abalBefore = A.systemBalance(aroll.id);
  var averBefore = aroll.sharedVersion || aroll.version || 1;
  /* A must see the item B created */
  var srest = await A.Repository.approveRestock(sbi.item.id, { rollId: aroll.id, requestKey: 'shrk-2' });
  ok(srest.ok, 'supervisor restock succeeds on shared backend');
  await A.Repository.refresh();
  var aroll2 = A.FG().rolls.filter(function (r) { return r.id === sroll.id; })[0];
  ok(A.systemBalance(aroll.id) === abalBefore + 100, 'shared restock increases balance by 100');
  ok((aroll2.sharedVersion || aroll2.version) === averBefore + 1, 'shared restock increments roll version');
  /* stale version rejected */
  var sb2 = await B.Repository.createReturn({ reason: 'OVERAGE', requestKey: 'shk-3' });
  var sbi2 = await B.Repository.addReturnItem(sb2.return.id, { requestKey: 'shik-2' });
  await B.Repository.measureReturnItem(sbi2.item.id, 50);
  await B.Repository.inspectReturnItem(sbi2.item.id, 'GOOD');
  var staleShared = await rejectsCode(
    A.Repository.approveRestock(sbi2.item.id, { rollId: aroll.id, rollVersion: averBefore, requestKey: 'shrk-3' }),
    'ROLL_VERSION_CONFLICT');
  ok(staleShared, 'shared stale roll version is rejected');
  /* idempotent retry does not double-apply */
  var rdup = await A.Repository.approveRestock(sbi.item.id, { rollId: aroll.id, requestKey: 'shrk-2' });
  await A.Repository.refresh();
  ok(rdup.ok && rdup.duplicate && A.systemBalance(aroll.id) === abalBefore + 100,
    'shared restock retry is idempotent');

  /* ================= J. shared: remnant + quarantine + scrap/vendor ================= */
  var sc = await A.Repository.createReturn({ reason: 'DAMAGED', requestKey: 'shk-4' });
  var sci = await A.Repository.addReturnItem(sc.return.id, { rollId: aroll.id, requestKey: 'shik-3' });
  await A.Repository.measureReturnItem(sci.item.id, 60);
  await A.Repository.inspectReturnItem(sci.item.id, 'DAMAGED');
  await A.Repository.refresh();
  var cbalBefore = A.systemBalance(aroll.id);
  var srem = await A.Repository.createReturnedRemnant(sci.item.id, { lengthIn: 60, requestKey: 'shmk-2' });
  ok(srem.ok && srem.remnant && /^REM-100001$/.test(srem.remnant.number), 'shared first remnant is REM-100001');
  await A.Repository.refresh();
  ok(A.systemBalance(aroll.id) === cbalBefore, 'shared remnant does not change parent balance');
  /* manager-only: supervisor scrap/vendor denied by server.
     Lift client gate so the request reaches the server. */
  var sci2 = await A.Repository.addReturnItem(sc.return.id, { requestKey: 'shik-4' });
  await A.Repository.inspectReturnItem(sci2.item.id, 'DEFECTIVE');
  setRole(A, 'MANAGER');
  var supScrapDenied = await rejectsCode(A.Repository.scrapReturnItem(sci2.item.id, { reason: 'test' }), 'NOT_AUTHORIZED');
  setRole(A, 'SUPERVISOR');
  ok(supScrapDenied, 'server rejects supervisor scrap with NOT_AUTHORIZED');
  setRole(A, 'MANAGER');
  var supVendDenied = await rejectsCode(A.Repository.sendReturnToVendor(sci2.item.id, { supplier: 'Acme' }), 'NOT_AUTHORIZED');
  setRole(A, 'SUPERVISOR');
  ok(supVendDenied, 'server rejects supervisor vendor return with NOT_AUTHORIZED');
  /* promote alice to manager in the double and retry */
  harness.setRole('alice@warehouse.com', 'MANAGER');
  setRole(A, 'MANAGER');
  var mscrap = await A.Repository.scrapReturnItem(sci2.item.id, { reason: 'test scrap', requestKey: 'shsk-1' });
  ok(mscrap.ok, 'manager scrap succeeds on shared backend');

  /* ================= K. shared: offline fail-fast ================= */
  A._nav.onLine = false;
  var off1 = false, off2 = false;
  try { await A.Repository.createReturn({ reason: 'OVERAGE' }); } catch (e) { off1 = e && e.code === 'OFFLINE'; }
  try { await A.Repository.approveRestock(sci.item.id, { rollId: aroll.id }); } catch (e) { off2 = e && e.code === 'OFFLINE'; }
  ok(off1 && off2, 'offline return mutations fail fast');
  A._nav.onLine = true;

  /* ================= L. shared: documents + multi-device visibility ================= */
  var sdoc = await A.Repository.uploadReturnDocument({ returnId: sc.return.id,
    imageDataUrl: tinyImg, employee: 'alice@warehouse.com' });
  ok(sdoc.ok && sdoc.doc.returnId === sc.return.id, 'shared return document uploads');
  await B.Repository.refresh();
  var bdocs = await B.Repository.getDocumentsForReturn(sc.return.id);
  ok(bdocs.length >= 1, 'return document visible on second device');

  /* ================= L2. shared: submit + remnant assignment ================= */
  var scSub = await A.Repository.createReturn({ reason: 'OVERAGE', requestKey: 'shk-5' });
  var scSubItem = await A.Repository.addReturnItem(scSub.return.id, { requestKey: 'shik-6' });
  await A.Repository.measureReturnItem(scSubItem.item.id, 40);
  await A.Repository.inspectReturnItem(scSubItem.item.id, 'GOOD');
  var ssub = await A.Repository.submitReturn(scSub.return.id);
  ok(ssub.ok, 'shared submitReturn succeeds');
  var ssubDup = await A.Repository.submitReturn(scSub.return.id);
  ok(ssubDup.ok && ssubDup.duplicate, 'shared submit retry is idempotent');
  /* shared remnant assignment: new item on the submitted return */
  var sci3 = await A.Repository.addReturnItem(scSub.return.id, { requestKey: 'shik-7' });
  await A.Repository.measureReturnItem(sci3.item.id, 80);
  await A.Repository.inspectReturnItem(sci3.item.id, 'GOOD');
  var srem2 = await A.Repository.createReturnedRemnant(sci3.item.id, { lengthIn: 80, requestKey: 'shrk-1' });
  ok(srem2.ok, 'shared remnant created for assignment');
  await A.Repository.refresh();
  var arems = await A.Repository.getReturnedRemnants(scSub.return.id);
  var sremRow = arems.filter(function (m) { return m.id === srem2.remnant.id; })[0];
  ok(sremRow && sremRow.status === 'AVAILABLE', 'shared remnant is AVAILABLE');
  /* seed a WO on device A for the assignment */
  A.FG().workOrders.push({ id: 'WO-SH1', number: 'WO-8001', opStatus: 'OPEN',
    lines: [{ id: 'SHL1', style: srem2.remnant.style, color: srem2.remnant.color,
      widthIn: srem2.remnant.widthIn, materialType: srem2.remnant.materialType, requiredIn: 60 }] });
  var sash = await A.Repository.assignRemnantInventory({ remnantId: srem2.remnant.id,
    woId: 'WO-SH1', lineId: 'SHL1', reservedIn: 50,
    employee: 'alice@warehouse.com', clientRequestId: 'shak-1' });
  ok(sash.ok && sash.remnantNumber === srem2.remnant.number, 'shared remnant assignment succeeds');
  var sashDup = await A.Repository.assignRemnantInventory({ remnantId: srem2.remnant.id,
    woId: 'WO-SH1', lineId: 'SHL1', reservedIn: 50,
    employee: 'alice@warehouse.com', clientRequestId: 'shak-1' });
  ok(sashDup.ok && sashDup.duplicate, 'shared remnant assignment retry is idempotent');

  /* ================= M. integrations ================= */
  var Z = makeDevice();
  setRole(Z, 'SUPERVISOR');
  var zr = Z.createReturnLocal({ reason: 'OVERAGE', workOrderId: 'XS024536', salesOrderId: 'SO-100245', loadoutId: 'LOAD-100001', requestKey: 'zrk-1' });
  ok(zr.ok, 'return links WO/SO/loadout');
  var woRets = (Z.FG().returns || []).filter(function (x) { return x.workOrderId === 'XS024536'; });
  ok(woRets.length === 1 && woRets[0].id === zr.return.id, 'WO-linked return is queryable');
  var dashPending = Z.returnsByTab('PENDING');
  ok(dashPending.length >= 1, 'dashboard PENDING tab includes the new return');
  var zit = Z.addReturnItemLocal(zr.return.id, { rollId: '16628697', requestKey: 'zik-1' });
  Z.measureReturnItemLocal(zit.item.id, 25, {});
  Z.inspectReturnItemLocal(zit.item.id, 'GOOD', {});
  Z.approveRestockLocal(zit.item.id, { rollId: '16628697', requestKey: 'zsk-1' });
  var ledgerActs = (Z.FG().returnActivity || []).filter(function (a) { return a.rollId === '16628697'; });
  ok(ledgerActs.length >= 1, 'restock writes roll-ledger return activity');

  /* ================= N. regression: return detail screen renders ================= */
  var R = makeDevice();
  setRole(R, 'SUPERVISOR');
  var rr = R.createReturnLocal({ reason: 'EXCESS MATERIAL', requestKey: 'reg-1' });
  ok(rr.ok, 'regression return created');
  var detailThrew = null, detailHtml = '';
  try {
    var out = R.Screens['return'](rr.return.id);
    detailHtml = (out && out.html) || '';
  } catch (e) { detailThrew = e; }
  ok(!detailThrew, 'return detail screen renders without throwing (returnActivityFor defined)');
  ok(detailHtml.indexOf(rr.return.number) !== -1, 'return detail HTML contains the RET- number');
  /* by number lookup path as well */
  var detailThrew2 = null, detailHtml2 = '';
  try {
    var out2 = R.Screens['return'](rr.return.number);
    detailHtml2 = (out2 && out2.html) || '';
  } catch (e) { detailThrew2 = e; }
  ok(!detailThrew2 && detailHtml2.indexOf(rr.return.number) !== -1,
    'return detail resolves by RET- number too');

  /* ================= O. returned-remnant assignment to work orders ================= */
  var RA = makeDevice();
  setRole(RA, 'SUPERVISOR');
  /* seed a work order with a material line matching the remnant */
  var rawo = { id: 'WO-RA1', number: 'WO-9001', opStatus: 'OPEN',
    lines: [{ id: 'L1', style: 'Shaw', color: 'Beige', widthIn: 144, materialType: 'Carpet', requiredIn: 200 }] };
  RA.FG().workOrders.push(rawo);
  var rar = RA.createReturnLocal({ reason: 'EXCESS MATERIAL', requestKey: 'rark-1' });
  var rait = RA.addReturnItemLocal(rar.return.id, { style: 'Shaw', color: 'Beige', widthIn: 144,
    materialType: 'Carpet', returnedQuantity: 120, requestKey: 'rarik-1' });
  RA.measureReturnItemLocal(rait.item.id, 120, {});
  RA.inspectReturnItemLocal(rait.item.id, 'GOOD', {});
  var rarem = RA.createReturnedRemnantLocal(rait.item.id, { lengthIn: 120, requestKey: 'rarrk-1' });
  ok(rarem.ok && rarem.remnant.status === 'AVAILABLE', 'remnant created AVAILABLE');
  var raAssign = RA.assignRemnantInventoryLocal({ remnantId: rarem.remnant.id,
    woId: 'WO-RA1', lineId: 'L1', reservedIn: 100, requestKey: 'raak-1' });
  ok(raAssign.ok && raAssign.rec.remnantNumber === rarem.remnant.number,
    'remnant assigns to WO line, REM- identity preserved');
  ok(raAssign.rec.rollId === null && raAssign.rec.remnantId === rarem.remnant.id,
    'assignment references remnant, not a roll');
  ok(rarem.remnant.status === 'ASSIGNED', 'remnant moves AVAILABLE -> ASSIGNED');
  /* double-assign rejected */
  var raAssign2 = RA.assignRemnantInventoryLocal({ remnantId: rarem.remnant.id,
    woId: 'WO-RA1', lineId: 'L1', reservedIn: 10, requestKey: 'raak-2' });
  ok(!raAssign2.ok && raAssign2.err === 'REMNANT NOT AVAILABLE', 'assigned remnant cannot be assigned again');
  /* over-length rejected */
  RA.FG().returnedRemnants.push({ id: 'REM-TEST2', number: 'REM-100002', returnId: rar.return.id,
    style: 'Shaw', color: 'Beige', widthIn: 144, materialType: 'Carpet',
    lengthIn: 60, status: 'AVAILABLE' });
  var raAssign3 = RA.assignRemnantInventoryLocal({ remnantId: 'REM-TEST2',
    woId: 'WO-RA1', lineId: 'L1', reservedIn: 999, requestKey: 'raak-3' });
  ok(!raAssign3.ok && raAssign3.err === 'INSUFFICIENT REMNANT LENGTH', 'cannot reserve more than remnant length');
  /* mismatch requires supervisor approval */
  RA.FG().workOrders.push({ id: 'WO-RA2', number: 'WO-9002', opStatus: 'OPEN',
    lines: [{ id: 'L2', style: 'Mohawk', color: 'Gray', widthIn: 144, materialType: 'Carpet', requiredIn: 50 }] });
  RA.FG().returnedRemnants.push({ id: 'REM-TEST3', number: 'REM-100003', returnId: rar.return.id,
    style: 'Shaw', color: 'Beige', widthIn: 144, materialType: 'Carpet',
    lengthIn: 60, status: 'AVAILABLE' });
  var RA2 = makeDevice();
  RA2.FG().workOrders = RA.FG().workOrders; RA2.FG().returnedRemnants = RA.FG().returnedRemnants;
  RA2.DB.data.currentEmployee = 'emp@warehouse.com';
  RA2.DB.data.employeeRoles = { 'emp@warehouse.com': 'EMPLOYEE' };
  var raAssign4 = RA2.assignRemnantInventoryLocal({ remnantId: 'REM-TEST3',
    woId: 'WO-RA2', lineId: 'L2', reservedIn: 50, requestKey: 'raak-4' });
  ok(!raAssign4.ok && raAssign4.err.indexOf('SUPERVISOR APPROVAL REQUIRED') >= 0,
    'material mismatch requires supervisor approval');
  /* remnant/assign screen renders */
  var scrThrew = null, scrHtml = '';
  try {
    var sout = RA.Screens['remnant/assign']('REM-TEST3');
    scrHtml = (sout && sout.html) || '';
  } catch (e) { scrThrew = e; }
  ok(!scrThrew && scrHtml.indexOf('REM-100003') !== -1, 'remnant assign screen renders with REM- number');

  /* ================= P. regression: UI-facing bug fixes ================= */
  /* P1: Repository.receiveReturn accepts { id } object (UI passes object, not string) */
  var RB = makeDevice();
  setRole(RB, 'SUPERVISOR');
  var rbr = RB.createReturnLocal({ reason: 'EXCESS MATERIAL', requestKey: 'rbrk-1' });
  var rbRecv = await RB.Repository.receiveReturn({ id: rbr.return.id });
  ok(rbRecv.ok && rbRecv.return.status === 'RECEIVED', 'receiveReturn accepts { id } object');
  /* P2: DB.SCHEMA matches seed schema so data persists across reload */
  ok(RB.DB.SCHEMA === 7, 'DB.SCHEMA is 7 (current)');
  var seedData = RB.DB.seed();
  ok(seedData.schema === 7, 'seed() writes schema 7');
  /* P3: returnPolicy defines all UI-gated permissions */
  var pol = RB.returnPolicy();
  ok(pol.canAddReturnItem === true, 'returnPolicy defines canAddReturnItem');
  ok(pol.canDispositionReturn === true, 'returnPolicy defines canDispositionReturn');
  ok(pol.canCompleteReturn === true, 'returnPolicy defines canCompleteReturn');
  /* P4: RECEIVED tab exists so received returns are visible */
  ok(RB.returnTabs().indexOf('RECEIVED') >= 0, 'returnTabs includes RECEIVED');
  /* P5: Repository facade accepts UI-style object calls (not just positional args) */
  var RC = makeDevice();
  setRole(RC, 'SUPERVISOR');
  var rcr = RC.createReturnLocal({ reason: 'EXCESS MATERIAL', requestKey: 'rcrk-1' });
  var rcRecv = await RC.Repository.receiveReturn({ id: rcr.return.id });
  ok(rcRecv.ok && rcRecv.return.status === 'RECEIVED', 'facade receiveReturn({id}) works');
  var rcItem = await RC.Repository.addReturnItem({ returnId: rcr.return.id, requestKey: 'rcik-1' });
  ok(rcItem.ok && rcItem.item.returnId === rcr.return.id, 'facade addReturnItem({returnId,...}) works');
  var rcMeas = await RC.Repository.measureReturnItem({ itemId: rcItem.item.id, measuredIn: 60 });
  ok(rcMeas.ok && rcMeas.item.measuredIn === 60, 'facade measureReturnItem({itemId,measuredIn}) works');
  var rcInsp = await RC.Repository.inspectReturnItem({ itemId: rcItem.item.id, condition: 'GOOD' });
  ok(rcInsp.ok && rcInsp.item.condition === 'GOOD', 'facade inspectReturnItem({itemId,...}) works');
  var rcSub = await RC.Repository.submitReturn({ id: rcr.return.id });
  ok(rcSub.ok && rcSub.return.status === 'READY_FOR_DISPOSITION', 'facade submitReturn({id}) works');

  await harness.close();
  console.log('run8: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch(function (e) { console.error('HARNESS ERROR', e); process.exit(1); });
