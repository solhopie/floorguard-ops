/* FloorGuard Ops — Run 9 pilot-hardening assertions.
   Run: node tests/run9.test.js
   Covers: migration chain (0010-0015), schema version gate + backend
   readiness checks, Pilot Diagnostics screen + role gating, Scanner Test
   screen isolation/normalization, camera-state UX, structured error logging
   with secret redaction, shared-reset restriction, remnant override reason
   plumbing, and no-secret-leakage static checks. */
var fs = require('fs');
var path = require('path');
var vm = require('vm');

/* ---------- minimal DOM/browser stubs in a vm sandbox ---------- */
var store = {};
function fakeEl() {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, className: '',
    onclick: null, onsubmit: null, style: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    addEventListener: function () {}, appendChild: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    querySelector: function () { return fakeEl(); },
    querySelectorAll: function () { return []; },
    focus: function () {}, click: function () {}, remove: function () {}
  };
}
/* Mock fetch: scripted per test via __mockRoutes = {pathFragment: {status, body}} */
var __mockRoutes = {};
function mockFetch(url, opts) {
  function resp(r) {
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: function () { return 'application/json'; } },
      json: function () { return Promise.resolve(r.body); },
      text: function () { return Promise.resolve(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)); }
    };
  }
  var u = String(url);
  var frags = Object.keys(__mockRoutes).sort(function (a, b) { return b.length - a.length; });
  for (var i = 0; i < frags.length; i++) {
    var frag = frags[i];
    if (u.indexOf(frag) >= 0) return Promise.resolve(resp(__mockRoutes[frag]));
  }
  return Promise.resolve(resp({ status: 404, body: { message: 'not found' } }));
}
var sandbox = {
  console: console,
  fetch: mockFetch,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  localStorage: {
    getItem: function (k) { return (k in store) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  },
  document: {
    addEventListener: function () {},
    getElementById: function () { return fakeEl(); },
    querySelector: function () { return fakeEl(); },
    querySelectorAll: function () { return []; },
    createElement: function () { return fakeEl(); },
    body: fakeEl()
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
sandbox.__mockRoutes = __mockRoutes;

var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

/* ================= A. migration chain ================= */
(function () {
  var migDir = path.join(__dirname, '..', 'supabase', 'migrations');
  var files = fs.readdirSync(migDir).filter(function (f) { return /\.sql$/.test(f); }).sort();
  ok(files.length >= 15, 'migrations 0001-0015 present (found ' + files.length + ')');
  function mig(n) { return fs.readFileSync(path.join(migDir, files.filter(function (f) { return f.indexOf(n) === 0; })[0]), 'utf8'); }
  var m10 = mig('0010'), m11 = mig('0011'), m12 = mig('0012'), m13 = mig('0013'), m14 = mig('0014'), m15 = mig('0015');
  ok(/COMPATIBILITY_OVERRIDE_DENIED/.test(m10), '0010: employee mismatch override denied');
  ok(/remnant_compatibility_overrides/.test(m10), '0010: append-only override table');
  ok(/MATERIAL_COMPATIBILITY_OVERRIDE/.test(m10), '0010: override audit event');
  ok(/override_reason/.test(m10), '0010: override reason recorded');
  ok(/'ASSIGNED'/.test(m10), '0010: remnant ASSIGNED status recognized');
  ok(/APPROVAL_DENIED/.test(m11), '0011: employee free-text approvals denied');
  ok(/Inventory release requires a Supervisor/.test(m11), '0011: direct assignment release gated');
  ok(/to authenticated/.test(m12), '0012: grants reach authenticated');
  ok(/request\.fg_cut_consuming/.test(m13), '0013: cut-consumption flag');
  ok(/schema_version_history/.test(m14), '0014: version history table');
  ok(/revoke.*from public/i.test(m15), '0015: PUBLIC execute revoked');
  ok(/CANNOT be removed/i.test(m15) && /REVOKE EXECUTE ON FUNCTION/i.test(m15), '0015: documents PUBLIC-default limitation honestly');
  ok(/to authenticated/.test(m15), '0015: re-grant to authenticated');
})();

/* ================= B. repository: schema version + readiness ================= */
(function () {
  eq(sandbox.REQUIRED_SCHEMA_VERSION, 15, 'REQUIRED_SCHEMA_VERSION is 15');
  eq(typeof sandbox.SharedRepo.getSchemaVersion, 'function', 'SharedRepo.getSchemaVersion exists');
  eq(typeof sandbox.SharedRepo.checkBackend, 'function', 'SharedRepo.checkBackend exists');
  ok(repoSrc.indexOf('BACKEND_UPDATE_REQUIRED') >= 0, 'readiness: BACKEND_UPDATE_REQUIRED error');
  ok(repoSrc.indexOf('NO_WAREHOUSE') >= 0, 'readiness: NO_WAREHOUSE error');
  ok(repoSrc.indexOf('STORAGE_MISSING') >= 0, 'readiness: STORAGE_MISSING error');
  ok(repoSrc.indexOf('p_override_reason') >= 0, 'reserve_remnant passes p_override_reason');
})();

async function readinessTests() {
  var R = sandbox.Repository, SR = sandbox.SharedRepo;
  function cfg() {
    R.saveConfig({ dataProvider: 'shared', supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'test-anon-key', warehouseId: 'WHA' });
  }
  function session() {
    store['floorguard_ops_session'] = JSON.stringify({ access_token: 'tok-123', email: 'mia@warehouse.test' });
  }
  /* happy path */
  cfg(); session();
  __mockRoutes['/rest/v1/'] = { status: 200, body: {} };
  __mockRoutes['/auth/v1/user'] = { status: 200, body: { email: 'mia@warehouse.test' } };
  __mockRoutes['schema_version_history'] = { status: 200, body: [{ version: 15 }] };
  __mockRoutes['/rest/v1/users'] = { status: 200, body: [{ id: 'U-MGR', warehouse_id: 'WHA', role: 'MANAGER' }] };
  __mockRoutes['/storage/v1/bucket/history-cards'] = { status: 200, body: { id: 'history-cards' } };
  var res = await SR.checkBackend();
  ok(res.ok === true, 'checkBackend happy path ok');
  ok(res.checks.length === 5, 'checkBackend runs 5 gates (got ' + res.checks.length + ')');
  ok(res.checks.every(function (c) { return c.ok; }), 'all 5 gates pass');
  /* stale schema */
  __mockRoutes['schema_version_history'] = { status: 200, body: [{ version: 13 }] };
  res = await SR.checkBackend();
  ok(res.ok === false && res.failedAt === 'schema', 'stale schema fails at schema gate');
  ok(/BACKEND_UPDATE_REQUIRED/.test(JSON.stringify(res)), 'stale schema -> BACKEND_UPDATE_REQUIRED');
  __mockRoutes['schema_version_history'] = { status: 200, body: [{ version: 15 }] };
  /* no warehouse membership */
  __mockRoutes['/rest/v1/users'] = { status: 200, body: [] };
  res = await SR.checkBackend();
  ok(res.ok === false && res.failedAt === 'warehouse', 'missing user fails at warehouse gate');
  ok(/NO_WAREHOUSE/.test(JSON.stringify(res)), 'missing user -> NO_WAREHOUSE');
  __mockRoutes['/rest/v1/users'] = { status: 200, body: [{ id: 'U-MGR', warehouse_id: 'WHA', role: 'MANAGER' }] };
  /* unreachable backend */
  __mockRoutes['/rest/v1/'] = { status: 502, body: { message: 'bad gateway' } };
  res = await SR.checkBackend();
  ok(res.ok === false && res.failedAt === 'reachable', 'unreachable fails at reachable gate');
  __mockRoutes['/rest/v1/'] = { status: 200, body: {} };
  /* no session */
  delete store['floorguard_ops_session'];
  res = await SR.checkBackend();
  ok(res.ok === false && res.failedAt === 'auth', 'missing session fails at auth gate');
  session();
  /* storage missing */
  __mockRoutes['/storage/v1/bucket/history-cards'] = { status: 404, body: { message: 'not found' } };
  res = await SR.checkBackend();
  ok(res.ok === false && res.failedAt === 'storage', 'missing bucket fails at storage gate');
  ok(/STORAGE_MISSING/.test(JSON.stringify(res)), 'missing bucket -> STORAGE_MISSING');
}

/* ================= C. app: versions, error log, scanner, diagnostics ================= */
(function () {
  eq(sandbox.APP_VERSION, '0.9.0', 'APP_VERSION is 0.9.0');

  /* --- structured error logging --- */
  var EL = sandbox.ErrorLog;
  eq(typeof EL.log, 'function', 'ErrorLog.log exists');
  eq(typeof EL.list, 'function', 'ErrorLog.list exists');
  eq(typeof EL.clear, 'function', 'ErrorLog.clear exists');
  eq(EL.MAX, 200, 'ErrorLog caps at 200');
  EL.clear();
  var logged = EL.log('test', 'op', 'BOOM', { token: 'secret-token-abc', nested: { password: 'hunter2', apiKey: 'key-xyz' } });
  ok(logged.detail.token === '[redacted]' && logged.detail.nested.password === '[redacted]' && logged.detail.nested.apiKey === '[redacted]', 'ErrorLog redacts token/password/apiKey');
  ok(logged.module === 'test' && logged.code === 'BOOM' && !!logged.at, 'ErrorLog entry has module/code/timestamp');
  var binLogged = EL.log('test', 'op', 'BIN', { blob: new Uint8Array([1, 2, 3]) });
  ok(binLogged.detail.blob === '[binary omitted]', 'ErrorLog omits binary payloads');
  var bigLogged = EL.log('test', 'op', 'BIG', { payload: 'x'.repeat(20000) });
  ok(bigLogged.detail.payload === '[binary/large payload omitted]', 'ErrorLog omits huge payloads');
  EL.clear();
  for (var i = 0; i < 250; i++) EL.log('test', 'op', 'M' + i, null);
  ok(EL.list().length === 200, 'ErrorLog ring buffer caps at 200');
  EL.clear();

  /* --- barcode detection --- */
  var det = sandbox.detectBarcodeType;
  eq(det('REM-1042'), 'REMNANT', 'REM- -> REMNANT');
  eq(det('RET-77'), 'RETURN', 'RET- -> RETURN');
  eq(det('WO-2001'), 'WORK ORDER', 'WO- -> WORK ORDER');
  eq(det('16628697'), 'ROLL', 'digits -> ROLL');
  eq(det('205b'), 'LOCATION', '205b -> LOCATION');
  eq(det('SO-1001'), 'SALES ORDER', 'SO- -> SALES ORDER');
  eq(det('ORD-55'), 'ORDER', 'ORD- -> ORDER');
  eq(det('RCV-55'), 'UNKNOWN', 'RCV- -> UNKNOWN (not a scannable entity)');
  eq(det('LO-9'), 'UNKNOWN', 'LO- -> UNKNOWN (not a scannable entity)');
  eq(det('!!!'), 'UNKNOWN', 'garbage -> UNKNOWN');
  eq(sandbox.normalizeBarcode('0116628697'), '16628697', '01-prefix stripped');
  eq(sandbox.normLoc('205b'), '205B', 'normLoc uppercases');

  /* --- camera states --- */
  var cs = sandbox.scannerCameraState;
  eq(cs(null).label, 'CAMERA READY', 'camera ready state');
  eq(cs('denied').label, 'CAMERA PERMISSION REQUIRED', 'camera denied state');
  eq(cs('no-api').label, 'CAMERA NOT AVAILABLE', 'camera unavailable state');
  ok(cs('denied').hint.indexOf('manual entry') >= 0, 'denied state mentions manual entry');
  ok(cs('no-api').hint.indexOf('manual entry') >= 0, 'unavailable state mentions manual entry');

  /* --- scanner test screen: isolation --- */
  var st = sandbox.Screens['scanner-test']().html;
  ok(st.indexOf('Raw barcode value') >= 0, 'scanner-test shows raw value');
  ok(st.indexOf('Normalized value') >= 0, 'scanner-test shows normalized');
  ok(st.indexOf('Detected type') >= 0, 'scanner-test shows detected type');
  ok(st.indexOf('Timestamp') >= 0, 'scanner-test shows timestamp');
  ok(st.indexOf('never writes inventory') >= 0, 'scanner-test states no inventory writes');

  /* --- diagnostics screen gating --- */
  var DB = sandbox.DB;
  DB.reset();
  DB.data.currentEmployee = 'Eddie';
  DB.data.employeeRoles = { 'Eddie': 'WAREHOUSE_EMPLOYEE', 'Mia': 'MANAGER' };
  var dWorker = sandbox.Screens['pilot-diagnostics']().html;
  ok(dWorker.indexOf('Managers and Admins only') >= 0, 'diagnostics restricted for workers');
  DB.data.currentEmployee = 'Mia';
  var dMgr = sandbox.Screens['pilot-diagnostics']().html;
  ok(dMgr.indexOf('Backend connection') >= 0, 'diagnostics shows backend checks for manager');
  ok(dMgr.indexOf('Schema version') >= 0, 'diagnostics shows schema version row');
  ok(dMgr.indexOf('Storage') >= 0, 'diagnostics shows storage row');

  /* --- reset restriction --- */
  var R = sandbox.Repository;
  R.saveConfig({ dataProvider: 'local' });
  DB.data.currentEmployee = 'Eddie';
  ok(sandbox.canResetData().ok === true, 'local mode reset allowed');
  R.saveConfig({ dataProvider: 'shared', supabaseUrl: 'https://xyz.supabase.co', supabaseAnonKey: 'k', warehouseId: 'WHA' });
  DB.data.employeeRoles = { 'Eddie': 'WAREHOUSE_EMPLOYEE', 'Ada': 'ADMIN' };
  DB.data.currentEmployee = 'Eddie';
  ok(sandbox.canResetData().ok === false, 'shared worker reset denied');
  DB.data.currentEmployee = 'Ada';
  ok(sandbox.canResetData().ok === true, 'shared admin reset allowed');
  R.saveConfig({ dataProvider: 'local' });

  /* --- settings: diagnostics entry + reset gating text --- */
  DB.data.currentEmployee = 'Mia';
  DB.data.employeeRoles = { 'Mia': 'MANAGER' };
  var settings = sandbox.Screens.settings().html;
  ok(settings.indexOf('PILOT DIAGNOSTICS') >= 0, 'settings has pilot diagnostics entry');
  var navRoutes = [];
  (sandbox.NAV || []).forEach(function (g) { (g.items || []).forEach(function (n) { navRoutes.push(n.route); }); });
  ok(navRoutes.indexOf('scanner-test') >= 0, 'nav has scanner test entry');

  /* --- remnant override reason plumbing (static) --- */
  ok(appSrc.indexOf('overrideReason') >= 0, 'app passes overrideReason');
  ok(appSrc.indexOf('Overriding as') >= 0 || appSrc.indexOf('OVERRIDE REASON') >= 0, 'app captures override reason in UI');

  /* --- no secret leakage (static) --- */
  ok(!/service_role/i.test(appSrc), 'no service-role in app.js');
  ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(appSrc), 'no hardcoded JWT in app.js');
  var urls = appSrc.match(/https:\/\/[a-z0-9-]+\.supabase\.co/gi) || [];
  ok(urls.every(function (u) { return /xyzcompany/.test(u); }), 'no hardcoded real Supabase URL in app.js (only placeholder)');
})();

/* ================= D. docs ================= */
(function () {
  var docs = path.join(__dirname, '..', 'docs');
  ['PILOT_BACKEND_SETUP.md', 'PILOT_DEVICE_TEST.md', 'PILOT_BACKUP_RECOVERY.md', 'PILOT_USERS.md'].forEach(function (f) {
    ok(fs.existsSync(path.join(docs, f)), 'doc exists: ' + f);
  });
  var setup = fs.readFileSync(path.join(docs, 'PILOT_BACKEND_SETUP.md'), 'utf8');
  ok(setup.indexOf('0001') >= 0 && setup.indexOf('0015') >= 0, 'setup covers migrations 0001-0015');
  ok(/never.*service/i.test(setup), 'setup warns never to enter service-role key');
  var users = fs.readFileSync(path.join(docs, 'PILOT_USERS.md'), 'utf8');
  ok(users.indexOf('WAREHOUSE_EMPLOYEE') >= 0, 'users doc covers roles');
  var dev = fs.readFileSync(path.join(docs, 'PILOT_DEVICE_TEST.md'), 'utf8');
  ok(dev.indexOf('Scanner Test') >= 0, 'device test covers scanner test');
})();

/* ================= E. phone CSS ================= */
(function () {
  var css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  ok(/max-width:\s*430px/.test(css), 'phone CSS covers 430px');
  ok(/max-width:\s*340px/.test(css), 'phone CSS covers 340px');
  ok(/min-height:\s*48px/.test(css), 'touch targets >= 48px');
  ok(/table/i.test(css) && /overflow/i.test(css), 'tables scroll instead of overflowing');
})();

readinessTests().then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch(function (e) {
  console.error('readiness harness error:', e);
  process.exit(1);
});
