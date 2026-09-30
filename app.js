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

var APP_VERSION = '0.1.0';

/* ---------------- data layer ----------------
   One localStorage key, schema version, per-module namespaces.
   Modules never touch each other's data: they read/write only
   through DB.ns('<module-key>'). */
var DB = {
  KEY: 'floorguard_ops_v1',
  SCHEMA: 1,
  data: null,
  seed: function () {
    return {
      schema: 1,
      currentEmployee: null,
      employees: ['Marcus', 'Dana', 'Luis'],
      modules: {},       /* per-module namespaces, created on demand via DB.ns() */
      settings: {}
    };
  },
  load: function () {
    try {
      var raw = localStorage.getItem(this.KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && d.schema === this.SCHEMA) { this.data = d; return; }
      }
    } catch (e) { /* corrupted or unavailable storage -> reseed */ }
    this.data = this.seed();
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
  reset: function () { this.data = this.seed(); this.save(); }
};

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
    points: ['Assign rolls to work and sales orders', 'Reservation tracking', 'Release unneeded reservations'] },
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
    points: ['Job schedule for the warehouse', 'Upcoming counts and cuts', 'Job assignments'] },
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
  var m = h.match(/^#\/([a-z0-9-]+)/);
  return m ? m[1] : 'dashboard';
}
function go(route) {
  window.location.hash = '#/' + route;
}
function resolveRoute(r) {
  if (r === 'signin') return 'signin';
  if (needsSignin()) return 'signin';
  if (Screens[r]) return r;
  return 'dashboard';
}
function updateTopbar(route) {
  document.body.classList.toggle('nosession', needsSignin());
  var chip = $('#empchip');
  chip.textContent = DB.data.currentEmployee || '';
}
function render() {
  closeDrawer();
  var r = resolveRoute(parseHash());
  var s = Screens[r]();
  $('#view').innerHTML = s.html;
  updateTopbar(r);
  markActiveNav(r);
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

/* In-app confirm modal (never the native confirm()). */
function showConfirm(opts) {
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
  function close() { wrap.remove(); }
  wrap.querySelector('#mc-ok').onclick = function () { close(); if (opts.onOk) opts.onOk(); };
  wrap.querySelector('#mc-cancel').onclick = close;
  wrap.onclick = function (e) { if (e.target === wrap) close(); };
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
  return {
    html:
      '<div class="screen">' +
      pageHead('Good ' + daypart() + ', ' + esc(DB.data.currentEmployee || 'team') + '.',
               todayStr() + ' · FloorGuard Ops') +
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
      '<div class="card"><h2>About</h2>' +
      '<div class="kv"><span class="k">Version</span><span class="num">' + esc(APP_VERSION) + ' (Run 1)</span></div>' +
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
    }
  };
};

/* Register a placeholder screen for every future module. */
Object.keys(MODULE_INFO).forEach(function (k) {
  if (k === 'settings') return; /* settings is a real screen above */
  Screens[k] = function () { return moduleScreen(k); };
});

/* ---------------- boot ---------------- */
function wireShell() {
  $('#hamburger').onclick = openDrawer;
  $('#scrim').onclick = closeDrawer;
  $('#empchip').onclick = function () { go('signin'); };
  document.addEventListener('keydown', function (e) {
    if (e && e.key === 'Escape') closeDrawer();
  });
}

DB.load();
renderDrawer();
wireShell();
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('hashchange', render);
}
render();
