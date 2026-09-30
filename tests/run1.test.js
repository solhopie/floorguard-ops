/* FloorGuard Ops — Run 1 foundation logic assertions.
   Run: node tests/run1.test.js
   Stubs the browser surface so app.js loads in Node; exercises the
   data layer, navigation structure, routing, and screen HTML. */
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
var sandbox = {
  console: console,
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
  navigator: { vibrate: function () {} }
};
vm.createContext(sandbox);

/* ---------- load the app (strip the boot block) ---------- */
var src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
var bootIdx = src.lastIndexOf('/* ---------------- boot'); /* real boot is last; a ported section reuses the word */
if (bootIdx >= 0) src = src.slice(0, bootIdx);
vm.runInContext(src, sandbox, { filename: 'app.js' });

var DB = sandbox.DB, NAV = sandbox.NAV, MODULE_INFO = sandbox.MODULE_INFO,
    Screens = sandbox.Screens, drawerHtml = sandbox.drawerHtml,
    parseHash = sandbox.parseHash, resolveRoute = sandbox.resolveRoute,
    needsSignin = sandbox.needsSignin, moduleScreen = sandbox.moduleScreen,
    navLabel = sandbox.navLabel;

/* ---------- assertions ---------- */
var passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

/* DB layer */
DB.data = DB.seed();
ok(DB.data.schema === 5, 'seed schema is 5 (shared FloorGuard store + scheduling + orders)');
ok(DB.data.currentEmployee === null, 'seed has no session');
ok(Array.isArray(DB.data.employees) && DB.data.employees.length === 3, 'seed has 3 demo employees');
ok(DB.data.modules && typeof DB.data.modules === 'object', 'seed has modules namespace map');
var ns1 = DB.ns('cycle-count');
ok(ns1 && typeof ns1 === 'object', 'DB.ns creates a module namespace');
ns1.sessions = [1, 2];
var ns2 = DB.ns('cycle-count');
ok(ns2.sessions.length === 2, 'DB.ns returns the same namespace on repeat calls');
DB.ns('cut-roll-tracking');
ok(!('sessions' in DB.ns('cut-roll-tracking')), 'module namespaces are isolated');
ok(JSON.parse(store[DB.KEY]).modules['cycle-count'].sessions.length === 2, 'namespaces persist to storage');
DB.data = DB.seed();
DB.data.currentEmployee = 'Marcus';
DB.save();
store = {}; DB.load();
ok(DB.data.currentEmployee === null, 'corrupt/missing storage reseeds cleanly');

/* Navigation structure */
var groups = NAV.map(function (g) { return g.group; });
ok(JSON.stringify(groups) === JSON.stringify(['DASHBOARD', 'WAREHOUSE', 'OPERATIONS', 'BUSINESS', 'SYSTEM']),
   'nav groups in the specified order');
var routes = [];
NAV.forEach(function (g) { g.items.forEach(function (it) { routes.push(it.route); }); });
ok(routes.length === 20, '20 nav items total, got ' + routes.length);
ok(new Set(routes).size === routes.length, 'all nav routes unique');
routes.forEach(function (r) {
  if (r === '__logout') return;
  ok(!!Screens[r], 'route has a screen: ' + r);
});
ok(!!MODULE_INFO['cycle-count'] && !!MODULE_INFO['cut-roll-tracking'], 'roadmap modules have info entries');
ok(MODULE_INFO['cycle-count'].points.indexOf('Free Run / Discovery Mode') >= 0,
   'cycle-count roadmap lists Free Run / Discovery Mode');
ok(MODULE_INFO['cut-roll-tracking'].points.indexOf('Cut amount') >= 0,
   'cut/roll roadmap lists Cut amount');
ok(navLabel('cycle-count') === 'Cycle Count', 'navLabel resolves');
ok(navLabel('nope') === 'FloorGuard Ops', 'navLabel falls back');

/* Drawer HTML */
var dh = drawerHtml();
['DASHBOARD', 'WAREHOUSE', 'OPERATIONS', 'BUSINESS', 'SYSTEM'].forEach(function (g) {
  ok(dh.indexOf(g) >= 0, 'drawer html contains group ' + g);
});
routes.forEach(function (r) {
  ok(dh.indexOf('data-route="' + r + '"') >= 0, 'drawer html contains route ' + r);
});

/* Routing */
DB.data = DB.seed();
sandbox.window.location.hash = '#/cycle-count';
ok(parseHash() === 'cycle-count', 'parseHash reads route');
sandbox.window.location.hash = '';
ok(parseHash() === 'dashboard', 'empty hash defaults to dashboard');
sandbox.window.location.hash = '#/not-a-route';
ok(resolveRoute(parseHash()) === 'signin', 'unknown route without session -> signin (session required)');
DB.data.currentEmployee = 'Dana';
ok(resolveRoute('not-a-route') === 'dashboard', 'unknown route with session -> dashboard');
ok(resolveRoute('cycle-count') === 'cycle-count', 'known route resolves');
ok(resolveRoute('signin') === 'signin', 'signin route always allowed');
DB.data.currentEmployee = null;
ok(needsSignin() === true, 'needsSignin when no session');
ok(resolveRoute('reports') === 'signin', 'module route without session -> signin');

/* Screens */
DB.data = DB.seed();
DB.data.currentEmployee = 'Marcus';
var dash = Screens.dashboard().html;
['work-orders', 'sales-orders', 'assign-inventory', 'cut-roll-tracking',
 'cycle-count', 'balance', 'history', 'scheduled-jobs', 'returns',
 'qa-warranty', 'reports'].forEach(function (r) {
  ok(dash.indexOf('data-route="' + r + '"') >= 0, 'dashboard tiles link to ' + r);
});
ok(dash.indexOf('Marcus') >= 0, 'dashboard greets the signed-in employee');
var signin = Screens.signin().html;
['Marcus', 'Dana', 'Luis'].forEach(function (e) {
  ok(signin.indexOf(e) >= 0, 'signin lists employee ' + e);
});
var cc = moduleScreen('cycle-count').html;
ok(cc.indexOf('History Card Capture') >= 0, 'cycle-count placeholder lists history card capture');
ok(cc.indexOf('modules.cycle-count') >= 0, 'placeholder names the reserved data namespace');
var settings = Screens.settings().html;
ok(settings.indexOf('floorguard_ops_v1') >= 0, 'settings shows the storage key');
ok(settings.indexOf('RESET DEMO DATA') >= 0, 'settings has reset demo data');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
