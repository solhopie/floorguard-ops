/* ======================================================================
   RUN 2 (consolidation): module hubs + Work Orders + Balance.
   Hand-authored for the Ops shell; they drive the ported warehouse core.
   ====================================================================== */

/* ---------------- CYCLE COUNT hub ---------------- */
Screens['cycle-count'] = function () {
  var disc = discrepancyRolls().length;
  var html =
    '<div class="screen">' +
    pageHead('🔄 Cycle Count', 'Free Run · Rapid · Verified') +
    '<button class="btn btn-free btn-huge" id="cc-free">🆓 FREE RUN CYCLE COUNT<br><span class="btn-sub">DISCOVERY MODE — any location, any roll</span></button>' +
    '<button class="btn btn-huge" id="cc-rapid">⚡ RAPID CYCLE COUNT<br><span class="btn-sub">scan location once, then roll after roll</span></button>' +
    '<button class="btn btn-primary btn-huge" id="cc-std">▶ STANDARD / VERIFIED COUNT<br><span class="btn-sub">compare against system inventory</span></button>' +
    '<button class="btn btn-huge" id="cc-sess">📋 COUNT SESSIONS</button>' +
    '<button class="btn btn-huge" id="cc-rev">⚠️ ITEMS REQUIRING REVIEW' +
      (disc ? ' <span class="count-badge">' + disc + '</span>' : '') + '</button>' +
    '<p class="hint">Free Run collects physical reality with no preloaded inventory. ' +
    'Standard mode compares against expected locations and balances.</p>' +
    '</div>';
  return { html: html, mount: function () {
    $('#cc-free').onclick = function () { newFreeRun(); go('count/free/loc'); };
    $('#cc-rapid').onclick = function () { newRapid(); go('count/rapid/loc'); };
    $('#cc-std').onclick = function () { newSession(); go('count/standard'); };
    $('#cc-sess').onclick = function () { go('count/sessions'); };
    $('#cc-rev').onclick = function () { go('count/review'); };
  }};
};

/* ---------------- CUT / ROLL TRACKING hub ---------------- */
Screens['cut-roll-tracking'] = function () {
  var cuts = FG().cuts.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); }).slice(0, 8);
  var rows = cuts.map(function (c) {
    return '<button class="rowbtn" data-roll="' + esc(c.rollId) + '">' +
      '<div class="rhead"><b class="mono">' + esc(c.rollId) + '</b>' +
      ' <span class="sub">cut <b class="num">' + fmtLen(c.inches) + '</b></span></div>' +
      '<div class="sub">' + (c.order ? 'Order <b class="mono">' + esc(c.order) + '</b> &middot; ' : '') +
      esc(c.by) + ' &middot; ' + fmtDT(c.at) + '</div></button>';
  }).join('');
  var html =
    '<div class="screen">' +
    pageHead('✂️ Cut / Roll Tracking', 'Scan · balance · cut · history') +
    '<button class="btn btn-primary btn-huge" id="crt-cut">📷 SCAN ROLL TO CUT</button>' +
    '<button class="btn btn-huge" id="crt-view">🔍 SCAN ROLL TO VIEW</button>' +
    '<button class="btn btn-huge" id="crt-search">⌨️ SEARCH ROLL</button>' +
    '<h2>Recent cuts</h2>' +
    (rows || '<p class="hint">No cuts recorded yet.</p>') +
    '</div>';
  return { html: html, mount: function () {
    $('#crt-cut').onclick = function () { newCutSession(); go('cut/scan'); };
    $('#crt-view').onclick = function () { go('rolls/scan'); };
    $('#crt-search').onclick = function () { go('rolls/search'); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-roll]'), function (b) {
      b.onclick = function () { go('roll', b.getAttribute('data-roll')); };
    });
  }};
};

/* Generic "scan a roll, then open it" used by the Cut/Roll hub. */
Screens['rolls/scan'] = function () {
  var html =
    '<div class="screen">' +
    '<div class="step-head">SCAN ROLL</div>' +
    '<h1>Scan a roll</h1>' +
    '<div class="cambox" id="cambox"></div>' +
    '<div id="result"></div>' +
    '<div class="card"><div class="label">TYPE THE BARCODE</div>' +
    '<form id="manualform"><div class="field"><input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN"></div>' +
    '<button class="btn btn-primary" type="submit">FIND ROLL</button></form></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
  }};
  function onCode(code) {
    var norm = normalizeBarcode(code);
    if (!norm) { bad(); return; }
    var roll = rollByBarcode(norm);
    if (roll) { good(); go('roll', roll.id); return; }
    var d = findDiscovered(norm);
    if (d) { good(); go('disc', d.id); return; }
    bad();
    $('#result').innerHTML = '<div class="err center">&#10060; ROLL NOT FOUND<br>' +
      '<span style="font-size:1rem">"' + esc(norm) + '" is not in the system.</span></div>' +
      '<button class="btn btn-free" id="todisc">🆓 OPEN IN FREE RUN (DISCOVERY)</button>';
    $('#todisc').onclick = function () { newFreeRun(); go('count/free/loc'); };
  }
};

/* ---------------- BALANCE ---------------- */
Screens['balance'] = function () {
  var rows = FG().rolls.map(function (r) {
    var exp = systemBalance(r.id);
    var meas = (r.measuredIn != null) ? fmtLen(r.measuredIn) : '—';
    var diff = (r.measuredIn != null) ? fmtDiff(r.measuredIn - exp) : '—';
    var dcls = (r.measuredIn != null) ? diffCls(r.measuredIn - exp) : '';
    return '<button class="rowbtn" data-roll="' + esc(r.id) + '">' +
      '<div class="rhead"><b class="mono">' + esc(r.id) + '</b>' +
      (r.measuredIn != null ? ' <span class="stchip st-green">MB ✓</span>' : '') + '</div>' +
      '<div class="sub">' + esc(r.style) + ' &middot; ' + esc(r.color) + ' &middot; loc <b class="mono">' + esc(r.expectedLocation) + '</b></div>' +
      '<div class="sub num">Exp <b>' + fmtLen(exp) + '</b> &middot; Meas <b>' + meas + '</b>' +
      ' &middot; Diff <b class="' + dcls + '">' + diff + '</b></div></button>';
  }).join('');
  return {
    html:
      '<div class="screen">' +
      pageHead('⚖️ Balance', 'Expected vs measured per roll') +
      (rows || '<p class="hint">No rolls in the system.</p>') +
      '</div>',
    mount: function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-roll]'), function (b) {
        b.onclick = function () { go('roll', b.getAttribute('data-roll')); };
      });
    }
  };
};

/* ---------------- WORK ORDERS ---------------- */
function woById(id) {
  return (FG().workOrders || []).filter(function (w) { return w.id === id; })[0] || null;
}
function woAssignChip(w) {
  return w.assignStatus === 'ASSIGNED'
    ? '<span class="stchip st-green">ASSIGNED' + (w.assignedTo ? ' · ' + esc(w.assignedTo) : '') + '</span>'
    : '<span class="stchip st-yellow">UNASSIGNED</span>';
}
function woStatusChip(w) {
  var cls = w.opStatus === 'COMPLETE' ? 'st-green' : (w.opStatus === 'IN_PROGRESS' ? 'st-blue' : 'st-gray');
  return '<span class="stchip ' + cls + '">' + esc(w.opStatus) + '</span>';
}

Screens['work-orders'] = function (param) {
  var tab = (param || 'ALL').toUpperCase();
  if (['ALL', 'ASSIGNED', 'UNASSIGNED'].indexOf(tab) < 0) tab = 'ALL';
  var list = (FG().workOrders || []).filter(function (w) {
    if (tab === 'ASSIGNED') return w.assignStatus === 'ASSIGNED';
    if (tab === 'UNASSIGNED') return w.assignStatus !== 'ASSIGNED';
    return true;
  });
  var tabs = ['ALL', 'ASSIGNED', 'UNASSIGNED'].map(function (t) {
    return '<button class="fchip' + (t === tab ? ' on' : '') + '" data-tab="' + t + '">' + t + '</button>';
  }).join('');
  var rows = list.map(function (w) {
    return '<button class="rowbtn" data-wo="' + esc(w.id) + '">' +
      '<div class="rhead"><b class="mono">' + esc(w.number) + '</b> ' + woAssignChip(w) + ' ' + woStatusChip(w) + '</div>' +
      '<div class="sub">' + esc(w.property) + ' &middot; ' + esc(w.account) + '</div>' +
      '<div class="sub">' + esc(w.style) + ' &middot; ' + esc(w.color) + ' &middot; ' + fmtWidth(w.widthIn) +
      (w.rollId ? ' &middot; roll <b class="mono">' + esc(w.rollId) + '</b>' : '') + '</div></button>';
  }).join('');
  var html =
    '<div class="screen">' +
    pageHead('🧾 Work Orders', 'Assign · track · cut against') +
    '<div class="chiprow">' + tabs + '</div>' +
    (rows || '<p class="hint center">No work orders in this view.</p>') +
    '</div>';
  return { html: html, mount: function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { go('work-orders', b.getAttribute('data-tab')); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-wo]'), function (b) {
      b.onclick = function () { go('work-order', b.getAttribute('data-wo')); };
    });
  }};
};

Screens['work-order'] = function (param) {
  var w = woById(param);
  if (!w) { setTimeout(function () { go('work-orders'); }, 0); return { html: '' }; }
  var roll = w.rollId ? rollById(w.rollId) : null;
  var cuts = FG().cuts.filter(function (c) { return c.order === w.number; })
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  var empOpts = DB.data.employees.map(function (e) {
    return '<option value="' + esc(e) + '"' + (w.assignedTo === e ? ' selected' : '') + '>' + esc(e) + '</option>';
  }).join('');
  var rollOpts = FG().rolls.map(function (r) {
    return '<option value="' + esc(r.id) + '"' + (w.rollId === r.id ? ' selected' : '') + '>' +
      esc(r.id) + ' — ' + esc(r.style) + ' (' + fmtLen(systemBalance(r.id)) + ')</option>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">← BACK</button>' +
    '<div class="step-head">WORK ORDER</div>' +
    '<h1 class="mono">' + esc(w.number) + '</h1>' +
    '<div>' + woAssignChip(w) + ' ' + woStatusChip(w) + '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Property</span><span class="v">' + esc(w.property) + '</span></div>' +
      '<div class="kv"><span class="k">Account</span><span class="v">' + esc(w.account) + '</span></div>' +
      '<div class="kv"><span class="k">Style / Color</span><span class="v">' + esc(w.style) + ' / ' + esc(w.color) + '</span></div>' +
      '<div class="kv"><span class="k">Material</span><span class="v">' + esc(w.materialType) + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + fmtWidth(w.widthIn) + '</span></div>' +
      '<div class="kv"><span class="k">Quantity</span><span class="v num">' + esc(String(w.quantity)) + ' ' + esc(w.uom) + '</span></div>' +
    '</div>' +
    '<h2>Assigned inventory</h2>' +
    '<div class="card">' +
      (roll
        ? '<div class="kv"><span class="k">Roll</span><span class="v mono"><b>' + esc(roll.id) + '</b></span></div>' +
          '<div class="kv"><span class="k">Roll balance</span><span class="v num">' + fmtLen(systemBalance(roll.id)) + '</span></div>' +
          '<button class="btn" id="goroll">VIEW ROLL</button>'
        : '<p class="hint">No roll assigned yet.</p>') +
      '<div class="field"><label class="label" for="wo-roll">LINK ROLL</label>' +
      '<select class="input" id="wo-roll"><option value="">— choose a roll —</option>' + rollOpts + '</select></div>' +
      '<div class="btn-row"><button class="btn btn-primary" id="wo-linkroll" style="flex:1">LINK ROLL</button>' +
      '<button class="btn" id="wo-scanroll" style="flex:1">📷 SCAN TO LINK</button></div>' +
    '</div>' +
    '<h2>Assignment</h2>' +
    '<div class="card">' +
      '<div class="field"><label class="label" for="wo-emp">ASSIGNED EMPLOYEE</label>' +
      '<select class="input" id="wo-emp"><option value="">— unassigned —</option>' + empOpts + '</select></div>' +
      '<button class="btn btn-primary" id="wo-assign">SAVE ASSIGNMENT</button>' +
    '</div>' +
    '<h2>Status</h2>' +
    '<div class="btn-row">' +
      '<button class="btn" id="wo-start" style="flex:1">▶ START WORK</button>' +
      '<button class="btn" id="wo-complete" style="flex:1">✔ COMPLETE</button>' +
    '</div>' +
    '<h2>Cut activity</h2>' +
    (cuts.length ? cuts.map(function (c) {
      return '<button class="rowbtn" data-roll="' + esc(c.rollId) + '">' +
        '<div class="rhead"><b class="mono">' + esc(c.rollId) + '</b>' +
        ' <span class="sub">cut <b class="num">' + fmtLen(c.inches) + '</b></span></div>' +
        '<div class="sub">' + esc(c.by) + ' &middot; ' + fmtDT(c.at) + ' &middot; new bal <b class="num">' + fmtLen(c.newIn) + '</b></div></button>';
    }).join('') : '<p class="hint">No cuts recorded against this work order yet.</p>') +
    '<button class="btn btn-primary btn-huge" id="wo-cut">✂️ CUT ROLL FOR THIS ORDER</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    if ($('#goroll')) $('#goroll').onclick = function () { go('roll', w.rollId); };
    $('#wo-assign').onclick = function () {
      var e = $('#wo-emp').value;
      w.assignedTo = e || null;
      w.assignStatus = e ? 'ASSIGNED' : 'UNASSIGNED';
      DB.save(); good(); render();
    };
    $('#wo-linkroll').onclick = function () {
      var rid = $('#wo-roll').value;
      if (!rid) { bad(); return; }
      w.rollId = rid;
      if (w.opStatus === 'OPEN') w.opStatus = 'IN_PROGRESS';
      DB.save(); good(); render();
    };
    $('#wo-scanroll').onclick = function () { go('work-order/link', w.id); };
    $('#wo-start').onclick = function () { w.opStatus = 'IN_PROGRESS'; DB.save(); good(); render(); };
    $('#wo-complete').onclick = function () {
      showConfirm({ title: 'Complete ' + w.number + '?', body: 'Marks the work order COMPLETE.', okLabel: 'COMPLETE' })
        .then(function (ok) { if (ok) { w.opStatus = 'COMPLETE'; DB.save(); good(); render(); } });
    };
    $('#wo-cut').onclick = function () {
      newCutSession();
      if (w.rollId && rollById(w.rollId)) { C.roll = rollById(w.rollId); C.woId = w.id; go('cut/entry'); }
      else go('cut/scan');
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-roll]'), function (b) {
      b.onclick = function () { go('roll', b.getAttribute('data-roll')); };
    });
  }};
};

/* Scan a roll to link it to a work order (assign inventory). */
Screens['work-order/link'] = function (param) {
  var w = woById(param);
  if (!w) { setTimeout(function () { go('work-orders'); }, 0); return { html: '' }; }
  var html =
    '<div class="screen">' +
    '<div class="step-head">LINK ROLL — ' + esc(w.number) + '</div>' +
    '<h1>Scan the roll</h1>' +
    '<div class="cambox" id="cambox"></div>' +
    '<div id="result"></div>' +
    '<div class="card"><div class="label">TYPE THE BARCODE</div>' +
    '<form id="manualform"><div class="field"><input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN"></div>' +
    '<button class="btn btn-primary" type="submit">LINK THIS ROLL</button></form></div>' +
    '<button class="btn" id="cancel">CANCEL</button>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    $('#cancel').onclick = function () { go('work-order', w.id); };
  }};
  function onCode(code) {
    var norm = normalizeBarcode(code);
    var roll = norm && rollByBarcode(norm);
    if (!roll) {
      bad();
      $('#result').innerHTML = '<div class="err center">&#10060; ROLL NOT FOUND — try again.</div>';
      return;
    }
    w.rollId = roll.id;
    if (w.opStatus === 'OPEN') w.opStatus = 'IN_PROGRESS';
    DB.save(); good();
    go('work-order', w.id);
  }
};
