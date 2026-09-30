/* ======================================================================
   PORTED FROM FloorGuard prototype (LEGACY / REFERENCE ONLY).
   Mechanical extraction; reviewed before merge. FG(). -> FG().
   ====================================================================== */

/* ---- prototype lines 179-212 ---- */
function rollById(id) {
  return FG().rolls.filter(function (r) { return r.id === id; })[0] || null;
}
/* Location codes are compared case-insensitively with stray spaces trimmed:
   "205b" and " 205B " both mean 205B. The scanned barcode value is
   authoritative — no format or prefix is required. */
function normLoc(s) { return String(s || '').trim().toUpperCase(); }
function rollByBarcode(code) {
  var c = String(code || '').trim().toUpperCase();
  var rolls = FG().rolls;
  var i, r;
  for (i = 0; i < rolls.length; i++) {
    r = rolls[i];
    if (r.barcode.toUpperCase() === c || r.id.toUpperCase() === c) return r;
  }
  /* Manufacturer tags often prefix the roll number (e.g. "01" + roll # on the
     printed tag). Retry with common prefixes stripped before giving up. */
  var stripped = c.replace(/^01/, '');
  if (stripped !== c && stripped) {
    for (i = 0; i < rolls.length; i++) {
      r = rolls[i];
      if (r.barcode.toUpperCase() === stripped || r.id.toUpperCase() === stripped) return r;
    }
  }
  return null;
}
/* System balance = beginning length minus all recorded cuts.
   Cycle counts never change it.
   --- TEMPORARY PILOT FUNCTIONALITY ---
   A supervisor can set roll.testBalanceIn via "SET TEST SYSTEM BALANCE" to stand
   in for the Real Floors system balance during the warehouse pilot. When set,
   it is returned instead of the computed value. To integrate the Real Floors
   API/database later: delete testBalanceIn and have systemBalance() fetch the
   authoritative balance from the backend instead. */

/* ---- prototype lines 213-221 ---- */
function systemBalance(rollId) {
  var roll = rollById(rollId);
  if (!roll) return 0;
  if (roll.testBalanceIn != null) return roll.testBalanceIn; /* TEMPORARY PILOT: Real Floors API replaces this */
  var cuts = FG().cuts.filter(function (c) { return c.rollId === rollId; });
  var used = cuts.reduce(function (s, c) { return s + c.inches; }, 0);
  return roll.beginningIn - used;
}
function isTestBalance(roll) { return !!(roll && roll.testBalanceIn != null); }

/* ---- prototype lines 226-229 ---- */
function isMeasuredCount(c) { return !!(c && (c.measured || c.physicalIn != null)); }

/* Rolls whose latest physical measurement differs from the expected balance.
   Shared by the Discrepancies screen and the dashboard badge so both agree. */

/* ---- prototype lines 230-260 ---- */
function discrepancyRolls() {
  var latest = {};
  FG().counts.forEach(function (c) {
    if (!isMeasuredCount(c)) return;
    if (!latest[c.rollId] || new Date(c.at) > new Date(latest[c.rollId].at)) latest[c.rollId] = c;
  });
  return Object.keys(latest).map(function (k) { return latest[k]; })
    .filter(function (c) { return c.diffIn !== 0; })
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
}

/* ---------------- Roll data model ------------------------------------------------
   Roll ID, Barcode, Style, Color, Width, Current Location live on the roll record.
   CURRENT EXPECTED BALANCE is never stored — it is calculated from transactions:
     starting balance (beginningIn) - sum of cuts = expected balance
   (or the temporary pilot testBalanceIn override when a supervisor set one).
   MEASURED BALANCE (MB): roll.measuredIn / measuredAt / measuredBy are stamped
   every time a worker physically measures the roll during a cycle count.
   Cut History = FG().cuts for the roll. Cycle Count History = FG().counts
   for the roll. History is append-only: records are never edited or deleted.
   A discrepancy NEVER changes the expected balance — it is recorded and queued
   for supervisor review on the Discrepancies screen. */

/* ---------------- Cut transaction service (integration seam) ----------------------
   ALL cut transactions go through CutService.recordCut() — the prototype UI and
   any future integration alike. Manual entry is the prototype path.
   FUTURE REAL FLOORS INTEGRATION: when Real Floors records an order/cut, an
   approved API/data integration calls CutService.recordCut() with the cut
   details, and FloorGuard updates the expected balance automatically — the
   employee must NOT enter the same cut twice. Keep this function separate from
   the UI so the integration can replace manual entry without touching screens.

/* ---- prototype lines 262-310 ---- */
var CutService = {
  /* opts: { rollId, order, cutIn, employee, location }
     Returns { ok:true, rec } or { ok:false, err }. */
  recordCut: function (opts) {
    var roll = rollById(opts.rollId);
    if (!roll) return { ok: false, err: 'Roll not found.' };
    var order = String(opts.order || '').trim().toUpperCase();
    if (!order) return { ok: false, err: 'Enter the order number.' };
    var cutIn = Math.round(Number(opts.cutIn));
    if (!isFinite(cutIn) || cutIn <= 0) return { ok: false, err: 'Cut length must be more than zero.' };
    var prevIn = systemBalance(roll.id);
    if (cutIn > prevIn) return { ok: false, err: 'Cut (' + fmtLen(cutIn) + ') exceeds the current balance (' + fmtLen(prevIn) + ').' };
    var now = new Date();
    var rec = {
      id: 'K' + Date.now().toString(36).toUpperCase(),
      rollId: roll.id, barcode: roll.barcode, order: order,
      prevIn: prevIn, inches: cutIn, newIn: prevIn - cutIn,
      location: opts.location || roll.expectedLocation,
      by: opts.employee || DB.data.currentEmployee,
      at: now.toISOString(), date: now.toLocaleDateString(), time: fmtTime(now.toISOString())
    };
    FG().cuts.push(rec); /* append-only: cut history is never edited or deleted */
    /* Keep a supervisor's temporary test balance in sync with recorded cuts. */
    if (roll.testBalanceIn != null) roll.testBalanceIn = Math.max(0, roll.testBalanceIn - cutIn);
    DB.save();
    return { ok: true, rec: rec };
  },
  recentOrders: function () {
    var seen = {}, out = [];
    FG().cuts.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); })
      .forEach(function (c) {
        if (c.order && !seen[c.order]) { seen[c.order] = 1; out.push(c.order); }
      });
    return out.slice(0, 8);
  }
};
function countsForRoll(rollId) {
  return FG().counts
    .filter(function (c) { return c.rollId === rollId; })
    .sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
}
function recentCountForRoll(rollId, withinMs) {
  var list = countsForRoll(rollId).filter(function (c) {
    return (Date.now() - new Date(c.at).getTime()) <= withinMs;
  });
  return list.length ? list[list.length - 1] : null;
}

/* ---------------- formatting ---------------------------------------------- */

/* ---- prototype lines 317-347 ---- */
function fmtLen(inches) {
  var n = Math.round(inches);
  var ft = Math.floor(n / 12), inch = n % 12;
  return ft + "' " + inch + '"';
}
/* signed difference -> -3" / +2' 4" / 0" */
function fmtDiff(d) {
  d = Math.round(d);
  if (d === 0) return '0"';
  var s = d < 0 ? '-' : '+';
  var a = Math.abs(d);
  if (a < 12) return s + a + '"';
  return s + fmtLen(a);
}
function diffCls(d) { return d === 0 ? 'diff-zero' : (d < 0 ? 'diff-neg' : 'diff-pos'); }
function fmtWidth(wIn) {
  return (wIn % 12 === 0) ? (wIn / 12) + ' FT' : fmtLen(wIn);
}
function fmtDT(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function isToday(iso) {
  var d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/* ---------------- status --------------------------------------------------- */

/* ---- prototype lines 348-401 ---- */
var STATUS = {
  MATCH:            { label: 'MATCH',            chip: 'st-green'  },
  SHORT:            { label: 'SHORT',            chip: 'st-red'    },
  OVER:             { label: 'OVER',             chip: 'st-yellow' },
  LOCATION_MISMATCH:{ label: 'LOCATION MISMATCH',chip: 'st-red'    },
  NEEDS_REVIEW:     { label: 'NEEDS REVIEW',     chip: 'st-yellow' },
  LOCATION_ISSUE:   { label: 'LOCATION ISSUE',   chip: 'st-red'    },
  NEWLY_DISCOVERED: { label: 'NEWLY DISCOVERED', chip: 'st-blue'   },
  COLLECTED:        { label: 'COLLECTED',        chip: 'st-blue'   }
};
function statusChip(status) {
  /* Accept both key form (LOCATION_ISSUE) and label form ('LOCATION ISSUE'),
     since status producers use the human-readable label. */
  var m = STATUS[status] || STATUS[String(status).replace(/ /g, '_')] || STATUS.NEEDS_REVIEW;
  return '<span class="stchip ' + m.chip + '">' + m.label + '</span>';
}
/* Location mismatch always wins over the balance comparison. */
function computeStatus(roll, scannedLoc, physicalIn, flagged) {
  if (normLoc(scannedLoc) !== normLoc(roll.expectedLocation)) {
    return flagged ? 'NEEDS_REVIEW' : 'LOCATION_MISMATCH';
  }
  var diff = physicalIn - systemBalance(roll.id);
  if (diff === 0) return 'MATCH';
  return diff < 0 ? 'SHORT' : 'OVER';
}

/* ---------------- device feedback (guarded) -------------------------------- */
function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern || 60); } catch (e) {}
}
function beep(freq, dur) {
  try {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    var ctx = new C();
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq || 880;
    g.gain.value = 0.12;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    var d = dur || 0.12;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d);
    o.stop(ctx.currentTime + d + 0.03);
  } catch (e) {}
}
function flash(color) {
  var f = document.getElementById('flash');
  if (!f) return;
  f.className = 'show ' + color;
  setTimeout(function () { f.className = ''; }, 380);
}
function good() { beep(880, 0.12); buzz(60); flash('green'); }
function bad()  { beep(220, 0.28); buzz([90, 50, 90]); flash('red'); }
function warn() { beep(520, 0.18); buzz(140); flash('yellow'); }

/* ---- prototype lines 405-539 ---- */
/* ---------------- camera barcode scanner -----------------------------------
   Uses getUserMedia + BarcodeDetector when the device supports them.
   Camera is a convenience only: big manual entry is ALWAYS offered, because
   desktops, denied permissions, and gloves must never block a count. */
var Scanner = {
  stream: null,
  stopFlag: false,
  zxReader: null,

  cameraAvailable: function () {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  },

  /* True when ANY barcode reader exists: the built-in API or our bundled ZXing. */
  hasReader: function () {
    return ('BarcodeDetector' in window) ||
      !!(window.ZXing && ZXing.BrowserMultiFormatReader);
  },

  start: function (videoEl, onCode) {
    var self = this;
    self.stop();
    self.stopFlag = false;
    if (!self.cameraAvailable()) return Promise.resolve({ ok: false, reason: 'no-camera-api' });
    /* Check for a barcode-reader API BEFORE asking for the camera: without one
       the preview can't scan anything, so skip the permission prompt entirely
       instead of flashing the user's own video and then failing. */
    if (!self.hasReader()) return Promise.resolve({ ok: false, reason: 'no-detector' });
    /* No built-in reader (older iOS) but our bundled ZXing is present. */
    if (!('BarcodeDetector' in window)) return self.startZxing(videoEl, onCode);
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (stream) {
        self.stream = stream;
        videoEl.srcObject = stream;
        return videoEl.play().catch(function () {});
      })
      .then(function () {
        var det = null;
        try {
          det = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar'] });
        } catch (e1) {
          try { det = new BarcodeDetector(); }
          catch (e2) { self.stop(); return { ok: false, reason: 'detector-init' }; }
        }
        var fails = 0, hintShown = false;
        var tick = function () {
          if (self.stopFlag) return;
          var p;
          try { p = det.detect(videoEl); }
          catch (e) { requestAnimationFrame(tick); return; }
          p.then(function (codes) {
            if (self.stopFlag) return;
            fails = 0;
            if (codes && codes.length && codes[0].rawValue) {
              self.stop();
              onCode(codes[0].rawValue);
            } else {
              requestAnimationFrame(tick);
            }
          }).catch(function () {
            if (self.stopFlag) return;
            fails++;
            if (fails >= 25 && !hintShown) {
              hintShown = true;
              var box = videoEl.parentNode;
              if (box) {
                var d = document.createElement('div');
                d.className = 'camnote';
                d.innerHTML = 'Having trouble reading &mdash; you can type the code or tap a DEMO chip below.';
                box.appendChild(d);
              }
            }
            requestAnimationFrame(tick);
          });
        };
        tick();
        return { ok: true, mode: 'camera' };
      })
      .catch(function () { self.stop(); return { ok: false, reason: 'denied' }; });
  },

  /* Fallback path for devices without the built-in BarcodeDetector (older iOS):
     decode with the bundled ZXing library instead. */
  startZxing: function (videoEl, onCode) {
    var self = this;
    self.stop();
    self.stopFlag = false;
    var reader;
    try {
      reader = new ZXing.BrowserMultiFormatReader();
    } catch (e) {
      return Promise.resolve({ ok: false, reason: 'detector-init' });
    }
    self.zxReader = reader;
    var p;
    try {
      p = reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        videoEl,
        function (result, err) {
          if (self.stopFlag) return;
          if (result && result.getText) {
            var txt = result.getText();
            if (txt) { self.stop(); onCode(txt); }
          }
          /* err is routine (no barcode in this frame); ignore it. */
        }
      );
    } catch (e) {
      self.stop();
      return Promise.resolve({ ok: false, reason: 'detector-init' });
    }
    return Promise.resolve(p).then(
      function () { return { ok: true, mode: 'camera-zxing' }; },
      function (e) {
        self.stop();
        var denied = e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError' || e.name === 'OverconstrainedError');
        return { ok: false, reason: denied ? 'denied' : 'detector-init' };
      }
    );
  },

  stop: function () {
    this.stopFlag = true;
    if (this.zxReader) {
      try { this.zxReader.reset(); } catch (e) {}
      this.zxReader = null;
    }
    if (this.stream) {
      try { this.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      this.stream = null;
    }
  }
};

/* ---- prototype lines 541-556 ---- */
var S = null;          /* active count session */
var lastSavedId = null;

function newSession() {
  S = { roll: null, scannedLoc: null, physicalIn: null, flagged: false };
}
/* Cut-transaction session. */
var C = null;
function newCutSession() {
  C = { roll: null, order: '', cutIn: null };
}
/* Rapid cycle-count session: one active location, then roll after roll. */
var R = null;
function newRapid() {
  R = { activeLoc: null, scan: null, lastMsg: null };
}

/* ---- prototype lines 605-607 ---- */
function needLoc()    { if (!needRoll() || !S.scannedLoc) { go('dashboard'); return false; } return true; }
function needBalance(){ if (!needLoc() || S.physicalIn == null) { go('dashboard'); return false; } return true; }

/* ---- prototype lines 677-732 ---- */
Screens['count/standard'] = function () {
  if (!S) newSession();
  var chips = FG().rolls.map(function (r) {
    return '<button class="demochip" data-code="' + esc(r.barcode) + '">' + esc(r.barcode) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">STEP 1 OF 4 &mdash; SCAN ROLL</div>' +
    '<h1>Scan roll barcode</h1>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE BARCODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
  }};

  function onCode(code) {
    var roll = rollByBarcode(code);
    if (!roll) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; ROLL NOT FOUND<br><span style="font-size:1rem">"' +
        esc(code) + '" is not in the system. Try again.</span></div>';
      return;
    }
    good();
    S.roll = roll;
    var scanned = String(code || '').trim().toUpperCase();
    var scannedRow = (scanned && scanned !== roll.barcode.toUpperCase() && scanned !== roll.id.toUpperCase())
      ? '<div class="kv"><span class="k">Scanned code</span><span class="v mono">' + esc(scanned) + '</span></div>'
      : '';
    $('#result').innerHTML =
      '<div class="ok-panel"><div class="big-ok">&#9989; ROLL IDENTIFIED</div>' +
      scannedRow +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Current Balance</span><span class="v num">' + fmtLen(systemBalance(roll.id)) + '</span></div>' +
      '</div>' +
      '<button class="btn btn-primary btn-huge" id="cont">CONTINUE &rarr; SCAN LOCATION</button>';
    $('#cont').onclick = function () { go('count/standard/loc'); };
    $('#cont').scrollIntoView(false);
  }
};

/* Shared camera-box wiring used by both scan steps. */

/* ---- prototype lines 733-811 ---- */
function mountScannerBox(boxId, onCode) {
  var box = document.getElementById(boxId);
  if (!Scanner.cameraAvailable()) {
    box.innerHTML = '<div class="camnote">This device has no camera.<br>Type the code or tap a DEMO chip below.</div>';
    return;
  }
  if (!Scanner.hasReader()) {
    /* No barcode-reader API on this device and the bundled fallback failed to
       load: don't prompt for the camera — it couldn't scan anyway. Manual
       entry and the DEMO chips are the way through. */
    box.innerHTML = '<div class="camnote">&#9888;&#65039; Auto-scan isn\'t supported on this iPhone\'s iOS version.<br>Type the code or tap a DEMO chip below &mdash; no camera needed.</div>';
    return;
  }
  box.innerHTML = '<video id="scanvideo" playsinline muted></video><div class="scanline"></div>';
  var video = document.getElementById('scanvideo');
  Scanner.start(video, onCode).then(function (res) {
    if (!res.ok) {
      var msg = res.reason === 'denied'
        ? 'Camera permission was denied. Allow camera access in Settings,<br>or type the code / tap a DEMO chip below.'
        : 'The barcode reader failed to start on this device.<br>Type the code or tap a DEMO chip below.';
      box.innerHTML = '<div class="camnote">' + msg + '</div>';
    }
  });
}

/* ---------------- SCAN LOCATION (step 2) ------------------------------------- */
Screens['count/standard/loc'] = function () {
  if (!needRoll()) return { html: '' };
  S.scannedLoc = null;
  /* Demo/test values only — real locations come from the scanned barcode. */
  var chips = ['205A', '205B', '206A', '206B', '204A', '204B'].map(function (l) {
    return '<button class="demochip" data-code="' + esc(l) + '">' + esc(l) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">STEP 2 OF 4 &mdash; SCAN LOCATION</div>' +
    '<h1>Scan the location barcode</h1>' +
    '<p class="hint">Roll <b class="mono">' + esc(S.roll.id) + '</b> &mdash; scan the location tag where it sits.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE LOCATION CODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. 205B">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
  }};

  function onCode(code) {
    var loc = normLoc(code);
    if (!loc) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; EMPTY SCAN &mdash; try again.</div>';
      return;
    }
    good();
    S.scannedLoc = loc;
    $('#result').innerHTML =
      '<div class="ok-panel"><div class="big-ok">&#9989; LOCATION VERIFIED</div>' +
      '<div class="kv"><span class="k">Scanned</span><span class="v mono" style="font-size:1.5rem">' + esc(loc) + '</span></div>' +
      '</div>' +
      '<button class="btn btn-primary btn-huge" id="cont">CONTINUE &rarr; ENTER BALANCE</button>';
    $('#cont').onclick = function () {
      var dup = recentCountForRoll(S.roll.id, 24 * 3600 * 1000);
      go(dup ? 'dup' : 'balance');
    };
    $('#cont').scrollIntoView(false);
  }
};

/* ---------------- SEARCH ROLL ------------------------------------------------- */

/* ---- prototype lines 812-874 ---- */
Screens['rolls/search'] = function () {
  var html =
    '<div class="screen">' +
    '<div class="step-head">FIND A ROLL</div>' +
    '<h1>Search rolls</h1>' +
    '<div class="field"><input class="input" id="q" autocomplete="off" placeholder="Roll #, style, color, location&hellip;"></div>' +
    '<div id="results"></div>' +
    '</div>';
  return { html: html, mount: function () {
    var renderResults = function () {
      var q = $('#q').value.trim().toLowerCase();
      var list = FG().rolls.filter(function (r) {
        if (!q) return true;
        return (r.id + ' ' + r.style + ' ' + r.color + ' ' + r.expectedLocation + ' ' + r.manufacturer)
          .toLowerCase().indexOf(q) >= 0;
      });
      $('#results').innerHTML = list.length ? list.map(function (r) {
        return '<button class="rowbtn" data-roll="' + esc(r.id) + '">' +
          '<div class="rhead"><b class="mono">' + esc(r.id) + '</b>' + lastCountChip(r.id) + '</div>' +
          '<div class="sub">' + esc(r.style) + ' &middot; ' + esc(r.color) + ' &middot; ' + esc(r.expectedLocation) +
          ' &middot; bal ' + fmtLen(systemBalance(r.id)) + '</div></button>';
      }).join('') : '<p class="hint center">No rolls match.</p>';
      Array.prototype.forEach.call(document.querySelectorAll('[data-roll]'), function (b) {
        b.onclick = function () { go('roll', b.getAttribute('data-roll')); };
      });
    };
    $('#q').addEventListener('input', renderResults);
    renderResults();
    $('#q').focus();
  }};
  function lastCountChip(rollId) {
    var c = countsForRoll(rollId);
    if (!c.length) return '<span class="stchip" style="background:var(--line);color:var(--muted)">NOT COUNTED</span>';
    return statusChip(c[c.length - 1].status);
  }
};

/* ---------------- DUPLICATE COUNT PROTECTION ---------------------------------- */
Screens['count/standard/dup'] = function () {
  if (!needLoc()) return { html: '' };
  var dup = recentCountForRoll(S.roll.id, 24 * 3600 * 1000);
  if (!dup) { setTimeout(function () { go('count/standard/balance'); }, 0); return { html: '' }; }
  var html =
    '<div class="screen">' +
    '<div class="warn-panel" style="background:var(--yellow-dark);border-color:var(--yellow)">' +
      '<h1>&#9888; THIS ROLL WAS<br>ALREADY COUNTED</h1>' +
      '<div class="kv"><span class="k">Last Count</span><span class="v">' + fmtDT(dup.at) + '</span></div>' +
      '<div class="kv"><span class="k">By</span><span class="v">' + esc(dup.employee) + '</span></div>' +
      '<div class="kv"><span class="k">Status</span><span class="v">' + statusChip(dup.status) + '</span></div>' +
    '</div>' +
    '<h2 class="center">Count again?</h2>' +
    '<div class="btn-row">' +
      '<button class="btn btn-green btn-huge" id="yes">YES</button>' +
      '<button class="btn btn-red btn-huge" id="cancel">CANCEL</button>' +
    '</div></div>';
  return { html: html, mount: function () {
    warn();
    $('#yes').onclick = function () { go('count/standard/balance'); };
    $('#cancel').onclick = function () { S = null; go('dashboard'); };
  }};
};

/* ---------------- ENTER PHYSICAL BALANCE (step 3) ------------------------------ */

/* ---- prototype lines 875-984 ---- */
Screens['count/standard/balance'] = function () {
  if (!needLoc()) return { html: '' };
  var roll = S.roll, sys = systemBalance(roll.id);
  var html =
    '<div class="screen">' +
    '<div class="step-head">STEP 3 OF 4 &mdash; PHYSICAL BALANCE</div>' +
    '<h1>Physical balance</h1>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(normLoc(S.scannedLoc)) + '</span></div>' +
      '<div class="kv"><span class="k">System Balance' +
        (isTestBalance(roll) ? ' <span class="stchip st-yellow">TEST</span>' : '') +
        '</span><span class="v num" style="font-size:1.5rem">' + fmtLen(sys) + '</span></div>' +
    '</div>' +
    '<div class="field"><label class="label">AMOUNT OF CARPET PHYSICALLY ON THE ROLL</label></div>' +
    '<div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">FEET</label>' +
      '<input class="input num balfield" id="ft" inputmode="numeric" autocomplete="off" placeholder="0"></div>' +
      '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
      '<input class="input num balfield" id="inch" inputmode="decimal" autocomplete="off" placeholder="0"></div>' +
    '</div>' +
    '<div class="big-readout num" id="combined">= 0\' 0"</div>' +
    '<div class="err" id="balerr" hidden></div>' +
    '<button class="btn btn-primary btn-huge" id="cont">CONTINUE &rarr; REVIEW</button>' +
    '</div>';
  return { html: html, mount: function () {
    var update = function () {
      var ft = parseFloat($('#ft').value) || 0, inch = parseFloat($('#inch').value) || 0;
      if (ft < 0 || inch < 0 || isNaN(ft) || isNaN(inch)) { $('#combined').textContent = '= —'; return; }
      $('#combined').textContent = '= ' + fmtLen(Math.round(ft * 12 + inch));
    };
    $('#ft').addEventListener('input', update);
    $('#inch').addEventListener('input', update);
    $('#cont').onclick = function () {
      var ft = parseFloat($('#ft').value), inch = parseFloat($('#inch').value);
      var err = '';
      if ($('#ft').value.trim() === '' && $('#inch').value.trim() === '') err = 'Enter feet and/or inches.';
      else if (isNaN(ft) || isNaN(inch) || ft < 0 || inch < 0) err = 'Numbers must be zero or more.';
      if (err) { bad(); var e = $('#balerr'); e.textContent = err; e.hidden = false; return; }
      S.physicalIn = Math.round(ft * 12 + inch);
      good();
      go(normLoc(S.scannedLoc) !== normLoc(S.roll.expectedLocation) ? 'mismatch' : 'confirm');
    };
  }};
};

/* ---------------- CONFIRM (step 4, location matches) -------------------------- */
Screens['count/standard/confirm'] = function () {
  if (!needBalance()) return { html: '' };
  var roll = S.roll, sys = systemBalance(roll.id), diff = S.physicalIn - sys;
  var status = computeStatus(roll, S.scannedLoc, S.physicalIn, false);
  var html =
    '<div class="screen">' +
    '<div class="step-head">STEP 4 OF 4 &mdash; CONFIRM COUNT</div>' +
    '<h1>Review before saving</h1>' +
    '<div class="card">' +
      kv('Roll #', '<span class="mono">' + esc(roll.id) + '</span>') +
      kv('Style', esc(roll.style)) +
      kv('Color', esc(roll.color)) +
      kv('Width', fmtWidth(roll.widthIn)) +
      kv('System Balance', '<span class="num">' + fmtLen(sys) + '</span>') +
      kv('Physical Balance', '<span class="num">' + fmtLen(S.physicalIn) + '</span>') +
      kv('Difference', '<span class="' + diffCls(diff) + ' num">' + fmtDiff(diff) + '</span>') +
      kv('Expected Location', '<span class="mono">' + esc(roll.expectedLocation) + '</span>') +
      kv('Scanned Location', '<span class="mono">' + esc(S.scannedLoc) + '</span>') +
      kv('Status', statusChip(status)) +
      kv('Employee', esc(DB.data.currentEmployee)) +
    '</div>' +
    '<button class="btn btn-green btn-huge" id="submit">SUBMIT COUNT</button>' +
    '<button class="linklike" id="back">&larr; go back and re-measure</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#submit').onclick = function () { submitCount(false); };
    $('#back').onclick = function () { go('count/standard/balance'); };
  }};
  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
};

/* ---------------- LOCATION MISMATCH warning ----------------------------------- */
Screens['count/standard/mismatch'] = function () {
  if (!needBalance()) return { html: '' };
  if (normLoc(S.scannedLoc) === normLoc(S.roll.expectedLocation)) { setTimeout(function () { go('count/standard/confirm'); }, 0); return { html: '' }; }
  var roll = S.roll;
  var html =
    '<div class="screen">' +
    '<div class="warn-panel">' +
      '<h1>&#9888; LOCATION<br>MISMATCH</h1>' +
      '<p style="color:#fecaca">This roll is <b>not</b> where the system expects it.<br>The location will <b>NOT</b> be changed automatically.</p>' +
      '<div class="vs">' +
        '<div><div class="k">EXPECTED LOCATION</div><div class="v mono">' + esc(roll.expectedLocation) + '</div></div>' +
        '<div><div class="k">SCANNED LOCATION</div><div class="v mono">' + esc(S.scannedLoc) + '</div></div>' +
      '</div>' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
    '</div>' +
    '<button class="btn btn-red btn-huge" id="save-mismatch">SAVE AS LOCATION MISMATCH</button>' +
    '<button class="btn btn-yellow btn-huge" id="flag">&#9888; FLAG FOR SUPERVISOR REVIEW</button>' +
    '<button class="linklike" id="goback">&larr; go back and re-scan the location</button>' +
    '</div>';
  return { html: html, mount: function () {
    bad();
    $('#save-mismatch').onclick = function () { submitCount(false); };
    $('#flag').onclick = function () { submitCount(true); };
    $('#goback').onclick = function () { S.scannedLoc = null; go('count/standard/loc'); };
  }};
};

/* ---------------- submit + saved --------------------------------------------- */

/* ---- prototype lines 985-1187 ---- */
function submitCount(flagged) {
  var roll = S.roll;
  var sys = systemBalance(roll.id);
  var diff = S.physicalIn - sys;
  var status = computeStatus(roll, S.scannedLoc, S.physicalIn, flagged);
  var now = new Date();
  var rec = {
    id: 'C' + Date.now().toString(36).toUpperCase(),
    rollId: roll.id, barcode: roll.barcode, style: roll.style, color: roll.color, widthIn: roll.widthIn,
    expectedLocation: roll.expectedLocation, scannedLocation: S.scannedLoc,
    expectedIn: sys, physicalIn: S.physicalIn, diffIn: diff,
    measured: true, /* MB: worker physically measured this roll */
    employee: DB.data.currentEmployee, at: now.toISOString(),
    date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
    status: status, flagged: !!flagged
  };
  FG().counts.push(rec); /* append-only: records are never edited or deleted */
  /* Stamp the roll's measured-balance fields so supervisors can distinguish
     the calculated/system balance from the last physical measurement. */
  roll.measuredIn = S.physicalIn;
  roll.measuredAt = rec.at;
  roll.measuredBy = rec.employee;
  DB.save();
  S = null;
  lastSavedId = rec.id;
  if (status === 'MATCH') good(); else if (status === 'NEEDS_REVIEW') warn(); else bad();
  go('count/standard/saved', rec.id);
}

/* ---------------- CUT TRANSACTION MODE -------------------------------------------
   SCAN ROLL -> SHOW CURRENT BALANCE -> ORDER NUMBER -> CUT LENGTH ->
   NEW BALANCE -> SAVE CUT -> READY STATE.
   The barcode identifies the ROLL only; the balance lives in the database and is
   recalculated from the cut history, so the same barcode stays on the roll for
   its whole life. All writes go through CutService.recordCut() (the Real Floors
   integration seam). The scanner implementation below is untouched — the shared
   mountScannerBox wiring is reused, not rebuilt. */
Screens['cut/scan'] = function () {
  if (!C) newCutSession();
  var chips = FG().rolls.map(function (r) {
    return '<button class="demochip" data-code="' + esc(r.barcode) + '">' + esc(r.barcode) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">CUT TRANSACTION &mdash; SCAN ROLL</div>' +
    '<h1>Scan roll barcode</h1>' +
    '<p class="hint">Scan the roll to cut. The barcode identifies the roll &mdash; the current balance comes from the database.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE BARCODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
  }};

  function onCode(code) {
    var roll = rollByBarcode(code);
    if (!roll) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; ROLL NOT FOUND<br><span style="font-size:1rem">"' +
        esc(code) + '" is not in the system. Try again.</span></div>';
      return;
    }
    good();
    C.roll = roll;
    $('#result').innerHTML =
      '<div class="ok-panel"><div class="big-ok">&#9989; ROLL IDENTIFIED</div>' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Current Balance</span><span class="v num" style="font-size:1.5rem">' + fmtLen(systemBalance(roll.id)) + '</span></div>' +
      '</div>' +
      '<button class="btn btn-primary btn-huge" id="cont">CONTINUE &rarr; ENTER CUT</button>';
    $('#cont').onclick = function () { go('cut/entry'); };
    $('#cont').scrollIntoView(false);
  }
};

Screens['cut/entry'] = function () {
  if (!C || !C.roll) { setTimeout(function () { go('cut/scan'); }, 0); return { html: '' }; }
  var roll = C.roll, bal = systemBalance(roll.id);
  var orderOpts = CutService.recentOrders().map(function (o) {
    return '<option value="' + esc(o) + '">';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">CUT TRANSACTION &mdash; ENTER CUT</div>' +
    '<h1>Record a cut</h1>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(roll.expectedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">Current Balance' +
        (isTestBalance(roll) ? ' <span class="stchip st-yellow">TEST</span>' : '') +
        '</span><span class="v num" style="font-size:1.5rem">' + fmtLen(bal) + '</span></div>' +
    '</div>' +
    '<div class="field"><label class="label" for="order">ORDER NUMBER</label>' +
      '<input class="input mono" id="order" list="orders" autocomplete="off" autocapitalize="characters" placeholder="e.g. XS024536">' +
      '<datalist id="orders">' + orderOpts + '</datalist></div>' +
    '<div class="field"><label class="label">CUT LENGTH</label></div>' +
    '<div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">FEET</label>' +
      '<input class="input num" id="cft" inputmode="numeric" autocomplete="off" placeholder="0"></div>' +
      '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
      '<input class="input num" id="cin" inputmode="decimal" autocomplete="off" placeholder="0"></div>' +
    '</div>' +
    '<div class="card"><div class="kv"><span class="k">NEW EXPECTED BALANCE</span>' +
      '<span class="v num" id="newbal" style="font-size:1.5rem">= ' + fmtLen(bal) + '</span></div></div>' +
    '<div class="err" id="cuterr" hidden></div>' +
    '<button class="btn btn-primary btn-huge" id="savecut">&#9986; SAVE CUT</button>' +
    '<button class="btn" id="cutcancel">CANCEL</button>' +
    '</div>';
  return { html: html, mount: function () {
    var update = function () {
      var ft = parseFloat($('#cft').value) || 0, inch = parseFloat($('#cin').value) || 0;
      if (ft < 0 || inch < 0 || isNaN(ft) || isNaN(inch)) { $('#newbal').textContent = '= —'; return; }
      var cut = Math.round(ft * 12 + inch);
      $('#newbal').textContent = '= ' + fmtLen(Math.max(0, bal - cut));
      $('#newbal').style.color = cut > bal ? 'var(--red)' : '';
    };
    $('#cft').addEventListener('input', update);
    $('#cin').addEventListener('input', update);
    $('#cutcancel').onclick = function () { newCutSession(); go('dashboard'); };
    $('#savecut').onclick = function () {
      var ft = $('#cft').value.trim(), inch = $('#cin').value.trim();
      var cutIn = Math.round((parseFloat(ft || '0')) * 12 + parseFloat(inch || '0'));
      var res = CutService.recordCut({
        rollId: roll.id, order: $('#order').value,
        cutIn: (ft === '' && inch === '') ? 0 : cutIn,
        employee: DB.data.currentEmployee, location: roll.expectedLocation
      });
      if (!res.ok) { bad(); var e = $('#cuterr'); e.textContent = res.err; e.hidden = false; return; }
      good();
      go('cut/saved', res.rec.id);
    };
  }};
};

Screens['cut/saved'] = function (param) {
  var rec = FG().cuts.filter(function (c) { return c.id === param; })[0];
  if (!rec) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var html =
    '<div class="screen">' +
    '<div class="ok-panel"><h1>&#9986; CUT SAVED</h1>' +
    '<div class="kv"><span class="k">NEW EXPECTED BALANCE</span>' +
    '<span class="v num" style="font-size:2rem">' + fmtLen(rec.newIn) + '</span></div></div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(rec.rollId) + '</span></div>' +
      '<div class="kv"><span class="k">Order</span><span class="v mono">' + esc(rec.order || '—') + '</span></div>' +
      '<div class="kv"><span class="k">Previous Balance</span><span class="v num">' + fmtLen(rec.prevIn) + '</span></div>' +
      '<div class="kv"><span class="k">Cut</span><span class="v num">' + fmtLen(rec.inches) + '</span></div>' +
      '<div class="kv"><span class="k">New Balance</span><span class="v num">' + fmtLen(rec.newIn) + '</span></div>' +
      '<div class="kv"><span class="k">By</span><span class="v">' + esc(rec.by) + ' &middot; ' + fmtDT(rec.at) + '</span></div>' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" id="another">&#9986; CUT ANOTHER ROLL</button>' +
    '<button class="btn btn-huge" id="done">DONE &rarr; HOME</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#another').onclick = function () { newCutSession(); go('cut/scan'); };
    $('#done').onclick = function () { newCutSession(); go('dashboard'); };
  }};
};

Screens['count/standard/saved'] = function (param) {
  var rec = FG().counts.filter(function (c) { return c.id === (param || lastSavedId); })[0];
  if (!rec) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var panel = { MATCH: 'ok-panel', SHORT: 'warn-panel', OVER: 'over-panel',
                LOCATION_MISMATCH: 'warn-panel', NEEDS_REVIEW: 'over-panel' }[rec.status] || 'over-panel';
  var statusColor = { MATCH: 'var(--green)', SHORT: 'var(--red)', OVER: 'var(--yellow)',
                      LOCATION_MISMATCH: 'var(--red)', NEEDS_REVIEW: 'var(--yellow)' }[rec.status] || 'var(--yellow)';
  var html =
    '<div class="screen">' +
    '<div class="' + panel + '"><h1>CYCLE COUNT RESULT</h1>' +
    '<div class="result-status" style="color:' + statusColor + '">' + STATUS[rec.status].label + '</div></div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll</span><span class="v mono result-num">' + esc(rec.rollId) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono result-num">' + esc(rec.scannedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">System Balance</span><span class="v num result-num">' + fmtLen(rec.expectedIn) + '</span></div>' +
      '<div class="kv"><span class="k">Physical Balance</span><span class="v num result-num">' + fmtLen(rec.physicalIn) + '</span></div>' +
      '<div class="kv"><span class="k">Difference</span><span class="v ' + diffCls(rec.diffIn) + ' num result-num">' + fmtDiff(rec.diffIn) + '</span></div>' +
      '<div class="kv"><span class="k">By</span><span class="v">' + esc(rec.employee) + ' &middot; ' + fmtDT(rec.at) + '</span></div>' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" id="another">&#9654; COUNT ANOTHER ROLL</button>' +
    '<button class="btn btn-huge" id="done">DONE &rarr; HOME</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#another').onclick = function () { newSession(); go('count/standard'); };
    $('#done').onclick = function () { go('dashboard'); };
  }};
};

/* ---------------- ROLL HISTORY ------------------------------------------------- */

/* ---- prototype lines 1188-1326 ---- */
Screens['roll'] = function (param) {
  var roll = rollById(param);
  if (!roll) { setTimeout(function () { go('rolls/search'); }, 0); return { html: '' }; }
  var sys = systemBalance(roll.id);
  var docs = docsForRoll(roll.id);
  var html =
    '<div class="screen">' +
    '<div class="step-head">ROLL HISTORY</div>' +
    '<h1 class="mono">' + esc(roll.id) + '</h1>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Manufacturer</span><span class="v">' + esc(roll.manufacturer) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + fmtWidth(roll.widthIn) + '</span></div>' +
      '<div class="kv"><span class="k">Beginning Length</span><span class="v num">' + fmtLen(roll.beginningIn) + '</span></div>' +
      '<div class="kv"><span class="k">Current Balance</span><span class="v num">' + fmtLen(sys) + '</span></div>' +
      '<div class="kv"><span class="k">Current Location</span><span class="v mono">' + esc(roll.expectedLocation) + '</span></div>' +
      (roll.measuredIn != null
        ? '<div class="kv"><span class="k">Measured Balance <span class="stchip st-green">MB ✓</span></span><span class="v num">' + fmtLen(roll.measuredIn) + '</span></div>' +
          '<div class="kv"><span class="k">Last Measured</span><span class="v">' + fmtDT(roll.measuredAt) + ' &middot; ' + esc(roll.measuredBy || '') + '</span></div>'
        : '<div class="kv"><span class="k">Measured Balance</span><span class="v">Not measured yet</span></div>') +
    '</div>' +
    '<button class="btn btn-primary btn-huge" id="scanhist">&#128247; SCAN HISTORY CARD</button>' +
    '<h2>Activity History</h2>' +
    '<div class="ledger">' + ledgerHtml(roll) + '</div>' +
    '<h2>Documents</h2>' +
    '<div class="label" style="margin-bottom:8px">ORIGINAL HISTORY CARDS</div>' +
    (docs.length ? docsHtml(docs) : '<div class="hint">No history cards captured yet.</div>') +
    '<button class="btn btn-primary btn-huge" id="countthis">&#9654; COUNT THIS ROLL</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#scanhist').onclick = function () {
      newDocCapture(roll.id, { location: roll.expectedLocation, returnTo: { name: 'roll', param: roll.id } });
      go('roll/doc');
    };
    $('#countthis').onclick = function () { newSession(); S.roll = roll; go('count/standard/loc'); };
    wireDocViews();
  }};
};

/* One-line summary of confirmed extracted fields for the timeline. */
function importSummary(f) {
  var bits = [];
  if (f.job) bits.push('Job ' + esc(f.job));
  if (f.order) bits.push('Order ' + esc(f.order));
  if (f.cut) bits.push('Cut ' + fmtLen(f.cut.totalIn));
  if (f.balance) bits.push('Balance ' + fmtLen(f.balance.totalIn));
  if (f.measured) bits.push('MB ' + fmtLen(f.measured.totalIn));
  if (f.date) bits.push(esc(f.date));
  if (f.size) bits.push('Size ' + esc(f.size));
  if (f.notes) bits.push('“' + esc(f.notes) + '”');
  return bits.length ? bits.join(' &middot; ') : 'No values entered.';
}

function ledgerHtml(roll) {
  var ev = [];
  FG().cuts.forEach(function (c) {
    if (c.rollId === roll.id) ev.push({ kind: 'cut', at: c.at, inches: c.inches, by: c.by, order: c.order, newIn: c.newIn });
  });
  FG().counts.forEach(function (c) {
    if (c.rollId === roll.id) ev.push({ kind: 'count', at: c.at, rec: c });
  });
  /* Free-run discovery counts for known rolls belong in the roll's history too:
     they are real physical measurements, tagged as free-run. */
  (FG().freeCounts || []).forEach(function (c) {
    if (c.rollId === roll.id) ev.push({ kind: 'freecount', at: c.at, rec: c });
  });
  /* History card captures and their confirmed smart-extractions are timeline
     events too. They never touch balances — they document the paper trail. */
  (FG().documents || []).forEach(function (d) {
    if (d.rollId === roll.id) {
      ev.push({ kind: 'doc', at: d.at, doc: d });
      (d.imports || []).forEach(function (imp) {
        ev.push({ kind: 'import', at: imp.confirmedAt, doc: d, imp: imp });
      });
    }
  });
  ev.sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  var out = '<div class="ledger-row"><span class="dot" style="background:var(--muted)"></span>' +
    '<div class="what"><b>Beginning Balance</b></div>' +
    '<div class="bal num">' + fmtLen(roll.beginningIn) + '</div></div>';
  var bal = roll.beginningIn;
  ev.forEach(function (e) {
    if (e.kind === 'cut') {
      /* Prefer the balance stored on the cut record (exact at cut time, and it
         already accounts for any test-balance adjustment); fall back to the
         running calculation only for legacy records that lack it. */
      var newBal = (e.newIn != null) ? e.newIn : (bal - e.inches);
      bal = newBal;
      var orderTag = e.order ? ' <span class="mono">Order ' + esc(e.order) + '</span>' : '';
      out += '<div class="ledger-row"><span class="dot" style="background:var(--blue)"></span>' +
        '<div class="what"><b>Cut</b> <span class="num">' + fmtLen(e.inches) + '</span>' + orderTag +
        '<div class="sub">' + fmtDT(e.at) + ' &middot; ' + esc(e.by) + ' &middot; <span class="srcchip">FLOORGUARD</span></div></div>' +
        '<div class="bal"><div class="sub">New Balance</div><span class="num">' + fmtLen(newBal) + '</span></div></div>';
    } else if (e.kind === 'count') {
      var r = e.rec;
      var phys = (r.physicalIn == null) ? '—' : fmtLen(r.physicalIn);
      var ddiff = (r.diffIn == null) ? '—' : fmtDiff(r.diffIn);
      var dcls = (r.diffIn == null) ? '' : diffCls(r.diffIn);
      var mb = isMeasuredCount(r) ? ' <span class="stchip st-green">MB ✓</span>' : '';
      out += '<div class="ledger-row"><span class="dot" style="background:' +
        (r.status === 'MATCH' ? 'var(--green)' : r.status === 'NEEDS_REVIEW' ? 'var(--yellow)' : 'var(--red)') + '"></span>' +
        '<div class="what"><b>Physical Cycle Count</b> <span class="num">' + phys + '</span> ' + statusChip(r.status) + mb +
        '<div class="sub">' + fmtDT(r.at) + ' &middot; ' + esc(r.employee) + ' &middot; loc <span class="mono">' + esc(r.scannedLocation) + '</span> &middot; <span class="srcchip">FLOORGUARD</span></div></div>' +
        '<div class="bal"><div class="sub">Difference</div><span class="' + dcls + ' num">' + ddiff + '</span></div></div>';
    } else if (e.kind === 'freecount') {
      /* Free-run discovery count: a real physical measurement collected without
         a system comparison. Shown with its COLLECTED status and MB marker. */
      var fc = e.rec;
      var fdiff = (fc.expectedIn == null) ? '—' : fmtDiff(fc.physicalIn - fc.expectedIn);
      out += '<div class="ledger-row"><span class="dot" style="background:var(--blue)"></span>' +
        '<div class="what"><b>Free-Run Count</b> <span class="num">' + fmtLen(fc.physicalIn) + '</span> ' +
        statusChip('COLLECTED') + ' <span class="stchip st-green">MB ✓</span>' +
        '<div class="sub">' + fmtDT(fc.at) + ' &middot; ' + esc(fc.employee) + ' &middot; loc <span class="mono">' + esc(fc.location) + '</span> &middot; <span class="srcchip">FLOORGUARD</span></div></div>' +
        '<div class="bal"><div class="sub">vs Expected</div><span class="num">' + fdiff + '</span></div></div>';
    } else if (e.kind === 'doc') {
      /* HISTORY CARD CAPTURED: the photo is the record. VIEW DOCUMENT opens
         the full-size original; the image is never altered after capture. */
      var dc = e.doc;
      out += '<div class="ledger-row"><span class="dot" style="background:var(--yellow)"></span>' +
        '<div class="what"><b>History Card Captured</b> <span class="srcchip">PAPER CARD</span>' +
        '<div class="sub">' + fmtDT(dc.at) + ' &middot; ' + esc(dc.employee) +
        (dc.location ? ' &middot; loc <span class="mono">' + esc(dc.location) + '</span>' : '') + '</div></div>' +
        '<div class="bal"><button class="btn btn-xs" data-docview="' + esc(dc.id) + '">VIEW DOCUMENT</button></div></div>';
    } else if (e.kind === 'import') {
      /* PAPER CARD IMPORT: human-confirmed data extracted from a history card.
         Displayed as history only — it never changes expected balances. */
      var im = e.imp;
      out += '<div class="ledger-row"><span class="dot" style="background:var(--yellow)"></span>' +
        '<div class="what"><b>Paper Card Import</b> <span class="srcchip src-import">PAPER CARD IMPORT</span>' +
        '<div class="sub">' + fmtDT(im.confirmedAt) + ' &middot; ' + esc(im.confirmedBy) + '</div>' +
        '<div class="sub">' + importSummary(im.fields) + '</div></div>' +
        '<div class="bal"><button class="btn btn-xs" data-docview="' + esc(im.docId || e.doc.id) + '">VIEW DOCUMENT</button></div></div>';
    }
  });
  return out;
}

/* ---------------- RECENT COUNTS + COUNT DETAIL (audit) -------------------------- */

/* ---- prototype lines 1327-1357 ---- */
Screens['history'] = function () {
  var list = FG().counts.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  var html =
    '<div class="screen">' +
    '<div class="step-head">AUDIT LOG &mdash; APPEND ONLY</div>' +
    '<h1>Recent counts</h1>' +
    (list.length ? list.map(countRow).join('') : '<p class="hint center">No counts yet.</p>') +
    '</div>';
  return { html: html, mount: function () { wireCountRows(); } };
};

function countRow(c) {
  var date = c.date || new Date(c.at).toLocaleDateString();
  var time = c.time || fmtTime(c.at);
  var mb = isMeasuredCount(c) ? ' <span class="stchip st-green">MB ✓</span>' : '';
  var balLine = (c.physicalIn == null)
    ? '<div class="sub">mismatch flagged — not measured</div>'
    : '<div class="sub num">Sys <b>' + fmtLen(c.expectedIn) + '</b> &middot; Phys <b>' + fmtLen(c.physicalIn) + '</b>' +
      ' &middot; Diff <b class="' + diffCls(c.diffIn) + '">' + fmtDiff(c.diffIn) + '</b></div>';
  return '<button class="rowbtn" data-count="' + esc(c.id) + '">' +
    '<div class="rhead"><b class="mono">' + esc(c.rollId) + '</b>' + statusChip(c.status) + mb + '</div>' +
    '<div class="sub"><b>' + esc(time) + '</b> &middot; loc <b class="mono">' + esc(c.scannedLocation) + '</b></div>' +
    balLine +
    '<div class="sub">' + esc(date) + ' &middot; ' + esc(c.employee) + '</div></button>';
}
function wireCountRows() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-count]'), function (b) {
    b.onclick = function () { go('count/detail', b.getAttribute('data-count')); };
  });
}

/* ---- prototype lines 1358-1401 ---- */
Screens['count/detail'] = function (param) {
  var c = FG().counts.filter(function (x) { return x.id === param; })[0];
  if (!c) { setTimeout(function () { go('history'); }, 0); return { html: '' }; }
  var roll = rollById(c.rollId);
  var barcode = c.barcode || (roll ? roll.barcode : c.rollId);
  var date = c.date || new Date(c.at).toLocaleDateString();
  var time = c.time || fmtTime(c.at);
  var html =
    '<div class="screen">' +
    '<div class="step-head">COUNT DETAIL</div>' +
    '<h1 class="mono">' + esc(c.rollId) + '</h1>' +
    '<div style="margin-bottom:8px">' + statusChip(c.status) + '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll Number</span><span class="v mono">' + esc(c.rollId) + '</span></div>' +
      '<div class="kv"><span class="k">Roll Barcode</span><span class="v mono">' + esc(barcode) + '</span></div>' +
      '<div class="kv"><span class="k">Product / Style</span><span class="v">' + esc(c.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(c.color) + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + fmtWidth(c.widthIn) + '</span></div>' +
      '<div class="kv"><span class="k">Location Barcode</span><span class="v mono">' + esc(c.scannedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">Expected Location</span><span class="v mono">' + esc(c.expectedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">Scanned Location</span><span class="v mono">' + esc(c.scannedLocation) + '</span></div>' +
      '<div class="kv"><span class="k">Expected Balance</span><span class="v num">' + fmtLen(c.expectedIn) + '</span></div>' +
      '<div class="kv"><span class="k">Physical Balance' + (isMeasuredCount(c) ? ' <span class="stchip st-green">MB ✓</span>' : '') + '</span><span class="v num">' +
        (c.physicalIn == null ? '— (not measured)' : fmtLen(c.physicalIn)) + '</span></div>' +
      '<div class="kv"><span class="k">Difference</span><span class="v ' + (c.diffIn == null ? '' : diffCls(c.diffIn)) + ' num">' +
        (c.diffIn == null ? '—' : fmtDiff(c.diffIn)) + '</span></div>' +
      '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(c.employee) + '</span></div>' +
      '<div class="kv"><span class="k">Date</span><span class="v">' + esc(date) + '</span></div>' +
      '<div class="kv"><span class="k">Time</span><span class="v">' + esc(time) + '</span></div>' +
      '<div class="kv"><span class="k">Count Status</span><span class="v">' + statusChip(c.status) + '</span></div>' +
    '</div>' +
    '<button class="btn" id="goroll">VIEW ROLL HISTORY</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#goroll').onclick = function () { go('roll', c.rollId); };
  }};
};

/* ---------------- SET TEST SYSTEM BALANCE (supervisor / pilot only) -------------
   TEMPORARY PILOT FUNCTIONALITY: the prototype is not connected to the Real
   Floors database yet, so a supervisor can type in the balance the Real Floors
   system currently shows for a roll. Stored as roll.testBalanceIn (integer
   inches); systemBalance() returns it when set, and it appears automatically
   when a worker scans the roll. To integrate the Real Floors API/database

/* ---- prototype lines 1476-1485 ---- */
var F = null;
function newFreeRun() {
  F = { id: 'FR' + Date.now().toString(36).toUpperCase(),
        startedAt: new Date().toISOString(),
        startedBy: DB.data.currentEmployee,
        activeLoc: null, scan: null, lastMsg: null };
}
/* Same normalization as rollByBarcode (manufacturer tags often prefix the roll
   number with "01"), so a scanned tag resolves identically for discovered
   rolls as it does for known ones. */

/* ---- prototype lines 1486-1586 ---- */
function normalizeBarcode(code) {
  var c = String(code || '').trim().toUpperCase();
  var s = c.replace(/^01/, '');
  return s || c;
}
function findDiscovered(id) {
  var ds = FG().discovered || [];
  for (var i = 0; i < ds.length; i++) if (ds[i].id === id) return ds[i];
  return null;
}
function freeCountsFor(sessionId) {
  return (FG().freeCounts || []).filter(function (c) { return c.sessionId === sessionId; });
}
function findFreeSession(id) {
  var ss = FG().freeSessions || [];
  for (var i = 0; i < ss.length; i++) if (ss[i].id === id) return ss[i];
  return null;
}

/* ================= PILOT SESSION & MANAGER REPORT =================
   Everything in this block is read-only reporting over the existing
   Free Run collections (freeSessions, freeCounts, discovered, documents).
   No existing counting/cut/scanner behavior is changed by these helpers. */

/* Human duration: 937000 -> "15m 37s", 5000 -> "5s". */
function fmtDur(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '—';
  var s = Math.round(ms / 1000);
  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

/* Per-count manager status for Free Run. Priority order:
   NEEDS REVIEW > LOCATION ISSUE > NEWLY DISCOVERED > MATCH/SHORT/OVER.
   A count is a discrepancy when its status is SHORT, OVER, LOCATION ISSUE,
   or NEEDS REVIEW. */
function freeCountStatus(c) {
  if (c.needsReview) return 'NEEDS REVIEW';
  if (c.locationIssue) return 'LOCATION ISSUE';
  if (c.discovered) return 'NEWLY DISCOVERED';
  if (c.expectedIn == null) return 'COLLECTED';
  var d = c.physicalIn - c.expectedIn;
  return d === 0 ? 'MATCH' : (d < 0 ? 'SHORT' : 'OVER');
}
function freeCountDiff(c) {
  return (c.expectedIn == null || c.physicalIn == null) ? null : c.physicalIn - c.expectedIn;
}
function isDiscrepancy(c) {
  var st = freeCountStatus(c);
  return st === 'SHORT' || st === 'OVER' || st === 'LOCATION ISSUE' || st === 'NEEDS REVIEW';
}

/* One denormalized row per counted roll in a session, for the report table. */
function reportRows(sessId) {
  return freeCountsFor(sessId).map(function (c) {
    var roll = c.discovered ? null : rollByBarcode(c.rollId);
    var sessDocs = docsForRoll(c.rollId).filter(function (d) { return d.sessionId === sessId; });
    return {
      loc: c.location, rollId: c.rollId, raw: c.raw || c.rollId,
      style: roll ? roll.style : '—', color: roll ? roll.color : '—',
      expectedIn: c.expectedIn, physicalIn: c.physicalIn,
      diffIn: freeCountDiff(c), mb: !!c.measured,
      docs: sessDocs.length, docIds: sessDocs.map(function (d) { return d.id; }),
      status: freeCountStatus(c), employee: c.employee, time: c.time, at: c.at,
      discovered: !!c.discovered, note: c.note || '', needsReview: !!c.needsReview,
      locationIssue: !!c.locationIssue
    };
  }).sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
}

/* Pilot metrics for a session: §11 of the pilot spec. */
function sessionMetrics(sessId) {
  var counts = freeCountsFor(sessId).slice()
    .sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  var locs = {}, rolls = {}, review = 0, disc = 0;
  counts.forEach(function (c) {
    locs[c.location] = 1; rolls[c.rollId] = 1;
    if (isDiscrepancy(c)) disc++;
    if (c.needsReview) review++;
  });
  var avgMs = null;
  if (counts.length > 1) {
    var gaps = 0;
    for (var i = 1; i < counts.length; i++)
      gaps += new Date(counts[i].at) - new Date(counts[i - 1].at);
    avgMs = gaps / (counts.length - 1);
  }
  var sess = findFreeSession(sessId);
  var totalMs = (sess && sess.endedAt)
    ? new Date(sess.endedAt) - new Date(sess.startedAt) : null;
  var cards = (FG().documents || []).filter(function (d) { return d.sessionId === sessId; }).length;
  return {
    rolls: counts.length, locations: Object.keys(locs).length,
    uniqueRolls: Object.keys(rolls).length, avgMs: avgMs, totalMs: totalMs,
    discrepancies: disc, needsReview: review, historyCards: cards
  };
}

/* Live session counter strip (§3): small, non-blocking, sits under the step head. */

/* ---- prototype lines 1587-1604 ---- */
function freeSessionBar() {
  if (!F || !F.id) return '';
  var counts = freeCountsFor(F.id);
  var locs = {}, measured = 0, review = 0;
  counts.forEach(function (c) {
    locs[c.location] = 1;
    if (c.measured) measured++;
    if (isDiscrepancy(c)) review++;
  });
  return '<div class="sessbar"><span class="sessbar-live">&#128994;</span> ' +
    '<b>SESSION IN PROGRESS</b> <span class="mono sessbar-id">' + esc(F.id) + '</span>' +
    '<div class="sessbar-nums">Locations <b>' + Object.keys(locs).length + '</b>' +
    ' &middot; Rolls Counted <b>' + counts.length + '</b>' +
    ' &middot; Measured <b>' + measured + '</b>' +
    ' &middot; Needs Review <b>' + review + '</b></div></div>';
}

/* --- STEP 1: scan ANY location. No DB requirement. --- */

/* ---- prototype lines 1605-1641 ---- */
Screens['count/free/loc'] = function () {
  if (!F) newFreeRun();
  var html =
    '<div class="screen">' +
    '<div class="step-head">FREE RUN &mdash; DISCOVERY MODE &mdash; STEP 1</div>' +
    '<h1>Scan location</h1>' +
    '<p class="hint">Scan <b>any</b> warehouse location barcode &mdash; it does <b>not</b> need to be preloaded. FloorGuard uses it as the active count location for every roll you scan next.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE LOCATION CODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. 210C">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">USE LOCATION</button></form>' +
    '<div id="result"></div>' +
    '<button class="btn btn-ghost" id="flcancel">CANCEL</button>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    $('#flcancel').onclick = function () { F = null; go('dashboard'); };
  }};
  function onCode(code) {
    var loc = normLoc(code);
    if (!loc) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; EMPTY SCAN &mdash; try again.</div>';
      return;
    }
    good();
    F.activeLoc = loc;
    F.lastMsg = null;
    go('count/free/scan');
  }
};

/* Custom confirm modal. Returns a Promise<boolean>. Tapping outside the
   dialog counts as cancel. */

/* ---- prototype lines 1663-1953 ---- */
function freeBanner() {
  var m = F && F.lastMsg;
  if (!m) return '';
  return '<div class="card" style="border:2px solid var(--blue);text-align:center">' +
    '<div style="font-size:1.4rem;font-weight:900;color:var(--blue)">' + esc(m) + '</div></div>';
}

Screens['count/free/scan'] = function () {
  if (!F || !F.activeLoc) { setTimeout(function () { go('count/free/loc'); }, 0); return { html: '' }; }
  var chips = FG().rolls.map(function (r) {
    return '<button class="demochip" data-code="' + esc(r.barcode) + '">' + esc(r.barcode) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">FREE RUN &mdash; DISCOVERY MODE</div>' +
    freeSessionBar() +
    '<div class="card" style="text-align:center">' +
      '<div class="label">ACTIVE LOCATION</div>' +
      '<div class="mono" style="font-size:2.4rem;font-weight:900">' + esc(F.activeLoc) + '</div>' +
    '</div>' +
    freeBanner() +
    '<h1>Scan roll</h1>' +
    '<p class="hint">Scan <b>any</b> roll &mdash; known or never-before-seen. New barcodes are discovered automatically.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE BARCODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. 01QH5CPHN">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '<div class="btn-row">' +
      '<button class="btn" id="fchangeloc" style="flex:1">&#8646; CHANGE LOCATION</button>' +
      '<button class="btn btn-primary" id="fend" style="flex:1">END COUNT SESSION</button>' +
    '</div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
    $('#fchangeloc').onclick = function () { go('count/free/loc'); };
    /* §4: confirm before finishing — CANCEL / FINISH. Custom modal, not the
       native confirm(): native dialogs can't show a FINISH button and are
       auto-dismissed by headless/automated browsers. */
    $('#fend').onclick = function () {
      var n = freeCountsFor(F.id).length;
      showConfirm({
        title: 'FINISH THIS CYCLE COUNT?',
        body: n + ' roll' + (n === 1 ? '' : 's') + ' collected in session ' + F.id +
              '. CANCEL keeps counting; FINISH ends the session.',
        okLabel: 'FINISH', cancelLabel: 'CANCEL'
      }).then(function (ok) { if (ok) endFreeSession(); });
    };
  }};

  function onCode(code) {
    var raw = String(code || '').trim();
    if (!raw) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; EMPTY SCAN &mdash; try again.</div>';
      return;
    }
    var id = normalizeBarcode(code);
    var roll = rollByBarcode(code);
    var expectedIn = null;
    if (roll) {
      /* Known roll: FloorGuard MAY show the expected balance, but it is never
         required and never blocks the count. */
      expectedIn = systemBalance(roll.id);
    } else {
      /* Never seen before: create the discovered-roll record right now so the
         physical scan is never an error. */
      var d = findDiscovered(id);
      if (!d) {
        d = { id: id, raw: raw.toUpperCase(),
              firstSeenAt: new Date().toISOString(), firstSeenBy: DB.data.currentEmployee,
              lastLocation: F.activeLoc,
              lastMeasuredIn: null, lastMeasuredAt: null, lastMeasuredBy: null, count: 0 };
        FG().discovered.push(d);
        DB.save();
      }
    }
    good();
    F.scan = { rollId: id, raw: raw.toUpperCase(), known: !!roll, expectedIn: expectedIn };
    go('count/free/balance');
  }
};

/* --- STEP 3: enter the physical balance, save, loop --- */
Screens['count/free/balance'] = function () {
  if (!F || !F.activeLoc || !F.scan) { setTimeout(function () { go('count/free/scan'); }, 0); return { html: '' }; }
  var s = F.scan;
  var roll = s.known ? rollByBarcode(s.rollId) : null;
  var rows;
  if (roll) {
    rows =
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v">' + fmtWidth(roll.widthIn) + '</span></div>' +
      '<div class="kv"><span class="k">Manufacturer</span><span class="v">' + esc(roll.manufacturer) + '</span></div>';
  } else {
    rows =
      '<div class="kv"><span class="k">Style</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>' +
      '<div class="kv"><span class="k">Width</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>' +
      '<div class="kv"><span class="k">Manufacturer</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>';
  }
  var expRow = s.expectedIn != null
    ? '<span class="v num" style="font-size:2rem">' + fmtLen(s.expectedIn) + '</span>'
    : '<span class="v" style="color:var(--muted)">Not available</span>';
  var html =
    '<div class="screen">' +
    '<div class="step-head">FREE RUN &mdash; DISCOVERY MODE &mdash; ' + esc(F.activeLoc) + '</div>' +
    freeSessionBar() +
    '<div class="card" style="text-align:center">' +
      '<div class="label">ROLL SCANNED</div>' +
      '<div class="mono" style="font-size:2.2rem;font-weight:900">' + esc(s.rollId) + '</div>' +
      (s.raw !== s.rollId ? '<div class="sub mono">tag read: ' + esc(s.raw) + '</div>' : '') +
      (s.known ? '' : '<div><span class="stchip st-blue">NEW / DISCOVERED</span></div>') +
    '</div>' +
    '<div class="card">' +
      rows +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(F.activeLoc) + '</span></div>' +
      '<div class="kv"><span class="k">EXPECTED BALANCE</span>' + expRow + '</div>' +
    '</div>' +
    '<div class="label">MEASURED BALANCE</div>' +
    '<button class="btn" id="fdochist" style="margin-bottom:14px">&#128247; SCAN HISTORY CARD <span class="sub">(optional)</span></button>' +
    '<button class="btn" id="fflag">&#9873; FLAG FOR REVIEW <span class="sub">(optional)</span></button>' +
    '<div class="field" id="fflagwrap" hidden style="margin-top:8px"><label class="label" for="fnote">REVIEW NOTE</label>' +
    '<input class="input" id="fnote" autocomplete="off" placeholder="e.g. label damaged, move pending"></div>' +
    '<div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">FEET</label>' +
      '<input class="input num" id="fft" inputmode="numeric" autocomplete="off" placeholder="0" style="font-size:2.2rem;min-height:84px;text-align:center"></div>' +
      '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
      '<input class="input num" id="fin" inputmode="decimal" autocomplete="off" placeholder="0" style="font-size:2.2rem;min-height:84px;text-align:center"></div>' +
    '</div>' +
    '<div class="card" style="text-align:center"><div class="label">MEASURED BALANCE</div>' +
      '<div class="num" id="fmeas" style="font-size:2.4rem;font-weight:900">0\' 0"</div></div>' +
    '<div class="err" id="ferr" hidden></div>' +
    '<button class="btn btn-primary btn-huge" id="fsavenext">&#10003; SAVE &amp; NEXT</button>' +
    '<button class="btn" id="fback">&larr; BACK TO SCANNER</button>' +
    '</div>';
  return { html: html, mount: function () {
    var upd = function () {
      var ft = parseFloat($('#fft').value) || 0, inch = parseFloat($('#fin').value) || 0;
      $('#fmeas').textContent = fmtLen(Math.round(ft * 12 + inch));
    };
    $('#fft').oninput = upd; $('#fin').oninput = upd;
    $('#fback').onclick = function () { F.scan = null; go('count/free/scan'); };
    /* FLAG FOR REVIEW: optional toggle. When on, the saved count carries
       needsReview=true plus the note, and shows up in NEEDS REVIEW. */
    $('#fflag').onclick = function () {
      s.flagReview = !s.flagReview;
      var on = s.flagReview;
      $('#fflag').className = 'btn' + (on ? ' btn-warn' : '');
      $('#fflag').innerHTML = on ? '&#9873; FLAGGED FOR REVIEW &mdash; TAP TO UNFLAG' : '&#9873; FLAG FOR REVIEW <span class="sub">(optional)</span>';
      $('#fflagwrap').hidden = !on;
      if (on) setTimeout(function () { $('#fnote').focus(); }, 50);
      else s.flagNote = '';
    };
    $('#fdochist').onclick = function () {
      /* Optional: capture the paper history card, then come back here to
         enter the measured balance. Never forced, normally once per roll. */
      newDocCapture(s.rollId, { location: F.activeLoc, returnTo: { name: 'free-balance' } });
      go('roll/doc');
    };
    $('#fsavenext').onclick = function () {
      var ft = parseFloat($('#fft').value), inch = parseFloat($('#fin').value);
      var err = '';
      if ($('#fft').value.trim() === '' && $('#fin').value.trim() === '') err = 'Enter feet and/or inches.';
      else if (isNaN(ft) || isNaN(inch) || ft < 0 || inch < 0) err = 'Numbers must be zero or more.';
      if (err) { bad(); var e = $('#ferr'); e.textContent = err; e.hidden = false; return; }
      s.flagNote = s.flagReview ? ($('#fnote').value || '') : '';
      saveFreeCount(ft, inch);
    };
  }};
};

function saveFreeCount(ft, inch) {
  var s = F.scan;
  var physicalIn = Math.round(ft * 12 + inch);
  var now = new Date();
  var rec = {
    id: 'FC' + now.getTime().toString(36).toUpperCase(),
    sessionId: F.id,
    rollId: s.rollId, barcode: s.rollId, raw: s.raw,
    discovered: !s.known,
    location: F.activeLoc,
    measuredFt: ft, measuredInch: inch, physicalIn: physicalIn,
    expectedIn: s.expectedIn, /* null for discovered rolls: no system balance */
    status: 'COLLECTED',      /* discovery collects; it never judges */
    measured: true,          /* MB: the worker physically measured this roll */
    employee: DB.data.currentEmployee,
    at: now.toISOString(),
    date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
    /* Pilot session fields (§2): optional review flag + note; locationIssue is
       auto-detected when a known roll is counted away from its expected
       location. Older records simply lack these fields (treated as false). */
    needsReview: !!(s.flagReview), note: (s.flagNote || '').trim() || null,
    locationIssue: (s.known && (function () {
      var r = rollByBarcode(s.rollId);
      return r && normLoc(F.activeLoc) !== normLoc(r.expectedLocation);
    })())
  };
  FG().freeCounts.push(rec);
  if (s.known) {
    /* A real physical measurement: stamp the roll's measured fields so the
       supervisor can see the last physical reading in roll history. */
    var roll = rollByBarcode(s.rollId);
    if (roll) { roll.measuredIn = physicalIn; roll.measuredAt = rec.at; roll.measuredBy = rec.employee; }
  } else {
    var d = findDiscovered(s.rollId);
    if (d) {
      d.lastLocation = F.activeLoc;
      d.lastMeasuredIn = physicalIn;
      d.lastMeasuredAt = rec.at;
      d.lastMeasuredBy = rec.employee;
      d.count++;
    }
  }
  DB.save();
  good();
  F.lastMsg = '✓ COLLECTED — ' + s.rollId + ' ' + fmtLen(physicalIn);
  F.scan = null;
  go('count/free/scan'); /* straight back to the scanner — never home */
}

function endFreeSession() {
  if (!F) { go('dashboard'); return; }
  var now = new Date();
  FG().freeSessions.push({
    id: F.id, startedAt: F.startedAt, startedBy: F.startedBy, endedAt: now.toISOString()
  });
  DB.save();
  F.endedAt = now.toISOString();
  go('count/free/summary');
}

/* --- SESSION SUMMARY: supervisor review of the whole collected count --- */
Screens['count/free/summary'] = function () {
  if (!F || !F.id) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var sessId = F.id;
  return { html: sessionSummaryHtml(sessId, 'DONE &mdash; BACK TO HOME'), mount: function () {
    mountSessionSummary(sessId, function () { F = null; go('dashboard'); });
  }};
};

/* --- PAST SESSION VIEW: reopen any finished session from COUNT SESSIONS --- */
Screens['count/session'] = function (sessId) {
  var sess = findFreeSession(sessId);
  if (!sess) { setTimeout(function () { go('count/sessions'); }, 0); return { html: '' }; }
  return { html: sessionSummaryHtml(sessId, '&larr; BACK TO SESSIONS'), mount: function () {
    mountSessionSummary(sessId, function () { go('count/sessions'); });
  }};
};

/* --- COUNT SESSIONS: list of every finished Free Run pilot session --- */
Screens['count/sessions'] = function () {
  var ss = (FG().freeSessions || []).slice()
    .sort(function (a, b) { return new Date(b.startedAt) - new Date(a.startedAt); });
  var rows = ss.map(function (s) {
    var m = sessionMetrics(s.id);
    return '<button class="sessrow" data-sess="' + esc(s.id) + '">' +
      '<div class="sessrow-top"><span class="mono"><b>' + esc(s.id) + '</b></span>' +
      '<span class="sub">' + esc(new Date(s.startedAt).toLocaleDateString()) + '</span></div>' +
      '<div class="sessrow-sub">' + esc(s.startedBy || '—') +
      ' &middot; ' + m.rolls + ' rolls &middot; ' + m.locations + ' locations' +
      ' &middot; ' + fmtDur(m.totalMs) +
      (m.discrepancies ? ' &middot; <span style="color:var(--red)">' + m.discrepancies + ' need review</span>' : '') +
      '</div></button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; HOME</button>' +
    '<div class="step-head">PILOT SESSIONS</div>' +
    '<h1>&#128203; COUNT SESSIONS</h1>' +
    '<p class="hint">Finished Free Run cycle-count sessions. Open one for its summary, manager report, and exports.</p>' +
    (rows || '<div class="hint center">No finished sessions yet.</div>') +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { go('dashboard'); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-sess]'), function (b) {
      b.onclick = function () { go('count/session', b.getAttribute('data-sess')); };
    });
  }};
};

/* --- SESSION SUMMARY (§5): shared renderer for free-summary + sessview --- */

/* ---- prototype lines 1954-2035 ---- */
function sessionSummaryHtml(sessId, doneLabel) {
  var sess = findFreeSession(sessId) || {};
  var m = sessionMetrics(sessId);
  var counts = freeCountsFor(sessId).slice()
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  var locs = [], disc = [];
  counts.forEach(function (c) {
    if (locs.indexOf(c.location) < 0) locs.push(c.location);
    if (c.discovered && disc.indexOf(c.rollId) < 0) disc.push(c.rollId);
  });
  function kv(k, v) {
    return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
  }
  var rows = counts.map(function (c) {
    return '<div class="trow">' +
      '<div class="mono"><b>' + esc(c.location) + '</b></div>' +
      '<div class="mono">' + esc(c.rollId) + (c.discovered ? ' <span class="stchip st-blue">NEW</span>' : '') + '</div>' +
      '<div class="num">' + fmtLen(c.physicalIn) + '</div>' +
      '<div class="center">✓</div>' +
      '<div class="sub">' + esc(c.time) + '</div></div>';
  }).join('');
  var discRows = disc.map(function (id) {
    var d = findDiscovered(id);
    if (!d) return '';
    var ddocs = docsForRoll(d.id);
    return '<div class="card">' +
      '<div class="kv"><span class="k">Roll Barcode</span><span class="v mono">' + esc(d.id) + '</span></div>' +
      '<div class="kv"><span class="k">Physical Location</span><span class="v mono">' + esc(d.lastLocation || '—') + '</span></div>' +
      '<div class="kv"><span class="k">Measured Balance</span><span class="v num">' +
        (d.lastMeasuredIn != null ? fmtLen(d.lastMeasuredIn) : '—') + '</span></div>' +
      '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(d.lastMeasuredBy || d.firstSeenBy || '—') + '</span></div>' +
      '<div class="kv"><span class="k">Date</span><span class="v">' + esc(new Date(d.lastMeasuredAt || d.firstSeenAt).toLocaleDateString()) + '</span></div>' +
      '<div class="kv"><span class="k">Time</span><span class="v">' + esc(d.lastMeasuredAt ? fmtTime(d.lastMeasuredAt) : fmtTime(d.firstSeenAt)) + '</span></div>' +
      (ddocs.length
        ? '<div class="kv"><span class="k">History Cards</span><span class="v">&#128247; ' + ddocs.length +
          ' &middot; <button class="btn btn-xs" data-docview="' + esc(ddocs[0].id) + '">VIEW</button></span></div>'
        : '') +
      '</div>';
  }).join('');
  var locChips = locs.map(function (l) { return '<span class="stchip st-blue" style="font-size:1.1rem">' + esc(l) + '</span>'; }).join(' ');
  var html =
    '<div class="screen">' +
    '<div class="step-head">FREE RUN &mdash; DISCOVERY MODE</div>' +
    '<h1>&#10003; CYCLE COUNT COMPLETE</h1>' +
    '<div class="card">' +
      kv('Employee', esc(sess.startedBy || '—')) +
      kv('Session', '<span class="mono">' + esc(sessId) + '</span>') +
      kv('Started', sess.startedAt ? fmtDT(sess.startedAt) : '—') +
      kv('Completed', sess.endedAt ? fmtDT(sess.endedAt) : '—') +
      kv('Duration', fmtDur(m.totalMs)) +
      kv('Locations Counted', '<span class="num">' + m.locations + '</span>') +
      kv('Rolls Counted', '<span class="num">' + m.rolls + '</span>') +
      kv('Measured Balances', '<span class="num">' + m.rolls + '</span>') +
      kv('History Cards Captured', '<span class="num">&#128247; ' + m.historyCards + '</span>') +
      kv('Discrepancies', '<span class="num">' + m.discrepancies + '</span>') +
      kv('Needs Review', '<span class="num">' + m.needsReview + '</span>') +
    '</div>' +
    '<button class="btn btn-primary btn-huge" id="sreport">&#128202; VIEW MANAGER REPORT</button>' +
    '<button class="btn" id="sexport">&#8681; EXPORT REPORT</button>' +
    '<div class="h2">Collected Counts</div>' +
    '<div class="thead trow"><div>LOCATION</div><div>ROLL</div><div>MEASURED</div><div>MB</div><div>TIME</div></div>' +
    (rows || '<div class="hint center">No rolls counted in this session.</div>') +
    '<div class="h2">Discovered Rolls</div>' +
    (discRows || '<div class="hint center">No new rolls discovered.</div>') +
    '<div class="h2">Discovered Locations</div>' +
    '<div class="card">' + (locChips || '<span class="hint">None.</span>') + '</div>' +
    '<button class="btn btn-primary btn-huge" id="fdone">' + doneLabel + '</button>' +
    '</div>';
  return html;
}
function mountSessionSummary(sessId, onDone) {
  $('#fdone').onclick = onDone;
  $('#sreport').onclick = function () { go('count/report', sessId); };
  $('#sexport').onclick = function () { go('count/export', sessId); };
  wireDocViews();
}

/* ================= MANAGER REPORT (§6) =================
   Professional per-session warehouse report over reportRows():
   filterable table + ITEMS REQUIRING REVIEW + tap-through roll detail.
   Read-only: nothing here changes counts, balances, or inventory. */
var REPORT_FILTERS = ['ALL', 'MATCH', 'SHORT', 'OVER', 'NEEDS REVIEW', 'NEWLY DISCOVERED'];

/* ---- prototype lines 2036-2317 ---- */
function reportFilterLabel(f) {
  var m = { ALL: 'All', MATCH: 'Match', SHORT: 'Short', OVER: 'Over',
            'NEEDS REVIEW': 'Needs Review', 'NEWLY DISCOVERED': 'Newly Discovered' };
  return m[f] || f;
}

function reportRowHtml(r) {
  var target = r.discovered ? 'disc-roll' : 'roll';
  return '<tr data-goto="' + target + '" data-roll="' + esc(r.rollId) + '">' +
    '<td class="mono"><b>' + esc(r.loc) + '</b></td>' +
    '<td class="mono">' + esc(r.rollId) + (r.discovered ? ' <span class="stchip st-blue">NEW</span>' : '') + '</td>' +
    '<td>' + esc(r.style) + '</td>' +
    '<td>' + esc(r.color) + '</td>' +
    '<td class="num">' + (r.expectedIn != null ? fmtLen(r.expectedIn) : '<span class="sub">—</span>') + '</td>' +
    '<td class="num"><b>' + fmtLen(r.physicalIn) + '</b></td>' +
    '<td class="num ' + (r.diffIn == null ? '' : diffCls(r.diffIn)) + '">' +
      (r.diffIn == null ? '<span class="sub">—</span>' : fmtDiff(r.diffIn)) + '</td>' +
    '<td class="center">✓</td>' +
    '<td class="center">' + (r.docs ? '&#128247; ' + r.docs : '<span class="sub">—</span>') + '</td>' +
    '<td>' + statusChip(r.status) + '</td>' +
    '<td class="sub">' + esc(r.time) + '</td></tr>';
}
function reportTableHtml(rows) {
  if (!rows.length) return '<div class="hint center">No rows match this filter.</div>';
  return '<div class="rtable-wrap"><table class="rtable"><thead><tr>' +
    '<th>LOCATION</th><th>ROLL</th><th>STYLE</th><th>COLOR</th><th>EXPECTED BALANCE</th>' +
    '<th>MEASURED BALANCE</th><th>DIFFERENCE</th><th>MB</th><th>HISTORY CARD</th><th>STATUS</th><th>TIME</th>' +
    '</tr></thead><tbody>' + rows.map(reportRowHtml).join('') + '</tbody></table></div>';
}
function filterReportRows(rows, f) {
  if (f === 'ALL') return rows;
  return rows.filter(function (r) { return r.status === f; });
}

Screens['count/report'] = function (sessId) {
  var sess = findFreeSession(sessId);
  if (!sess) { setTimeout(function () { go('count/sessions'); }, 0); return { html: '' }; }
  var rows = reportRows(sessId);
  var m = sessionMetrics(sessId);
  var cur = 'ALL';
  function chipsHtml() {
    return REPORT_FILTERS.map(function (f) {
      return '<button class="fchip' + (f === cur ? ' on' : '') + '" data-f="' + f + '">' +
        reportFilterLabel(f) + '</button>';
    }).join('');
  }
  function tableArea() {
    var fr = filterReportRows(rows, cur);
    var disc = rows.filter(isDiscrepancyRow);
    return '<div class="h2">Results <span class="sub">(' + fr.length + ' of ' + rows.length + ')</span></div>' +
      reportTableHtml(fr) +
      '<div class="h2">&#9888; ITEMS REQUIRING REVIEW <span class="sub">(' + disc.length + ')</span></div>' +
      (disc.length ? reportTableHtml(disc)
        : '<div class="hint center">Nothing needs review — every counted roll matched.</div>');
  }
  function isDiscrepancyRow(r) {
    return r.status === 'SHORT' || r.status === 'OVER' || r.status === 'LOCATION ISSUE' || r.status === 'NEEDS REVIEW';
  }
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">PILOT SESSION &mdash; MANAGER REPORT</div>' +
    '<h1>&#128202; MANAGER REPORT</h1>' +
    '<div class="card"><div class="kv"><span class="k">Session</span><span class="v mono">' + esc(sessId) + '</span></div>' +
    '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(sess.startedBy || '—') + '</span></div>' +
    '<div class="kv"><span class="k">Date</span><span class="v">' + esc(new Date(sess.startedAt).toLocaleDateString()) + '</span></div></div>' +
    '<div class="h2">Pilot Metrics</div>' +
    '<div class="card">' +
    '<div class="kv"><span class="k">Total Rolls Counted</span><span class="v num">' + m.rolls + '</span></div>' +
    '<div class="kv"><span class="k">Total Locations</span><span class="v num">' + m.locations + '</span></div>' +
    '<div class="kv"><span class="k">Avg Count Time / Roll</span><span class="v num">' + fmtDur(m.avgMs) + '</span></div>' +
    '<div class="kv"><span class="k">Total Session Time</span><span class="v num">' + fmtDur(m.totalMs) + '</span></div>' +
    '<div class="kv"><span class="k">Discrepancies</span><span class="v num">' + m.discrepancies + '</span></div>' +
    '<div class="kv"><span class="k">History Cards Digitized</span><span class="v num">&#128247; ' + m.historyCards + '</span></div>' +
    '</div>' +
    '<div class="h2">Filter</div>' +
    '<div class="fchips" id="fchips">' + chipsHtml() + '</div>' +
    '<div id="rtables">' + tableArea() + '</div>' +
    '<p class="hint center">Tap any roll row to open its full FloorGuard detail.</p>' +
    '<button class="btn" id="bexport">&#8681; EXPORT REPORT</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    $('#bexport').onclick = function () { go('count/export', sessId); };
    function wireRows() {
      Array.prototype.forEach.call(document.querySelectorAll('#rtables tr[data-goto]'), function (tr) {
        tr.onclick = function () { go(tr.getAttribute('data-goto'), tr.getAttribute('data-roll')); };
      });
    }
    function applyFilter(f) {
      cur = f;
      $('#fchips').innerHTML = chipsHtml();
      $('#rtables').innerHTML = tableArea();
      wireRows();
      wireChips();
    }
    function wireChips() {
      Array.prototype.forEach.call(document.querySelectorAll('#fchips .fchip'), function (b) {
        b.onclick = function () { applyFilter(b.getAttribute('data-f')); };
      });
    }
    wireRows();
    wireChips();
  }};
};

/* ================= EXPORT (§8) =================
   Prototype exports: PRINT/SAVE AS PDF (via the print-optimized view),
   CSV (every cycle-count row), JSON (structured FloorGuard data). */
function downloadFile(name, mime, text) {
  var blob = new Blob([text], { type: mime + ';charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}
function csvEsc(v) {
  if (v == null) return '';
  return '"' + String(v).replace(/"/g, '""') + '"';
}
function sessionExportRows(sessId) {
  var rows = reportRows(sessId);
  var head = ['session_id', 'location', 'roll', 'barcode_raw', 'style', 'color',
    'expected_in', 'measured_in', 'difference_in', 'measured_balance_mb',
    'history_cards', 'status', 'employee', 'time', 'note'];
  var lines = [head.map(csvEsc).join(',')];
  rows.forEach(function (r) {
    lines.push([
      sessId, r.loc, r.rollId, r.raw, r.style, r.color,
      r.expectedIn != null ? r.expectedIn : '',
      r.physicalIn,
      r.diffIn != null ? r.diffIn : '',
      r.mb ? 'YES' : 'NO',
      r.docs, r.status, r.employee, r.time, r.note || ''
    ].map(csvEsc).join(','));
  });
  return lines.join('\r\n');
}
function sessionExportJson(sessId) {
  var sess = findFreeSession(sessId) || {};
  var docs = (FG().documents || []).filter(function (d) { return d.sessionId === sessId; });
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    exportedBy: DB.data.currentEmployee || null,
    source: 'FLOORGUARD',
    session: {
      id: sessId, employee: sess.startedBy || null,
      startedAt: sess.startedAt || null, endedAt: sess.endedAt || null,
      metrics: sessionMetrics(sessId)
    },
    rows: reportRows(sessId).map(function (r) {
      return {
        location: r.loc, rollId: r.rollId, barcodeRaw: r.raw,
        style: r.style, color: r.color,
        expectedIn: r.expectedIn, measuredIn: r.physicalIn, differenceIn: r.diffIn,
        measuredBalance: r.mb, historyCards: r.docs, historyCardIds: r.docIds,
        status: r.status, employee: r.employee, time: r.time, at: r.at,
        discovered: r.discovered, needsReview: r.needsReview,
        locationIssue: r.locationIssue, note: r.note || null
      };
    }),
    documents: docs.map(function (d) {
      return {
        id: d.id, rollId: d.rollId, num: d.num, kind: d.docType,
        capturedAt: d.at, capturedBy: d.employee, location: d.location,
        sessionId: d.sessionId, source: d.source,
        imports: (d.imports || []).map(function (i) {
          return { fields: i.fields || null, confirmedAt: i.confirmedAt || null, confirmedBy: i.confirmedBy || null };
        })
      };
    })
  }, null, 2);
}

Screens['count/export'] = function (sessId) {
  var sess = findFreeSession(sessId);
  if (!sess) { setTimeout(function () { go('count/sessions'); }, 0); return { html: '' }; }
  var fname = 'floorguard-session-' + sessId;
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">PILOT SESSION &mdash; EXPORT</div>' +
    '<h1>&#8681; EXPORT REPORT</h1>' +
    '<p class="hint">Session <span class="mono">' + esc(sessId) + '</span> &middot; ' +
      esc(sess.startedBy || '—') + ' &middot; ' + esc(new Date(sess.startedAt).toLocaleDateString()) + '</p>' +
    '<button class="btn btn-primary btn-huge" id="xpdf">&#128438; PRINT / SAVE AS PDF</button>' +
    '<p class="hint">Opens the management-review layout. On iPhone: Share &rarr; Save to Files to keep a PDF.</p>' +
    '<button class="btn btn-huge" id="xcsv">&#8681; DOWNLOAD CSV</button>' +
    '<p class="hint">Every cycle-count row — opens in Excel / Sheets.</p>' +
    '<button class="btn btn-huge" id="xjson">&#8681; DOWNLOAD JSON</button>' +
    '<p class="hint">Structured FloorGuard data for future integration and testing.</p>' +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    $('#xpdf').onclick = function () { go('count/report/print', sessId); };
    $('#xcsv').onclick = function () { downloadFile(fname + '.csv', 'text/csv', sessionExportRows(sessId)); good(); };
    $('#xjson').onclick = function () { downloadFile(fname + '.json', 'application/json', sessionExportJson(sessId)); good(); };
  }};
};

/* ================= PRINT REPORT (§8 PDF) =================
   Print-optimized management review. window.print() -> Save as PDF. */
Screens['count/report/print'] = function (sessId) {
  var sess = findFreeSession(sessId);
  if (!sess) { setTimeout(function () { go('count/sessions'); }, 0); return { html: '' }; }
  var rows = reportRows(sessId);
  var m = sessionMetrics(sessId);
  var docs = (FG().documents || []).filter(function (d) { return d.sessionId === sessId; })
    .sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  function trow(cells) {
    return '<tr>' + cells.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
  }
  var dataRows = rows.map(function (r) {
    return trow([
      esc(r.loc), esc(r.rollId), esc(r.style), esc(r.color),
      r.expectedIn != null ? fmtLen(r.expectedIn) : '—',
      fmtLen(r.physicalIn),
      r.diffIn == null ? '—' : fmtDiff(r.diffIn),
      r.mb ? 'YES' : 'NO',
      r.docs ? r.docs + ' card' + (r.docs > 1 ? 's' : '') : '—',
      esc(r.status), esc(r.time)
    ]);
  }).join('');
  var discRows = rows.filter(function (r) {
    return r.status === 'SHORT' || r.status === 'OVER' || r.status === 'LOCATION ISSUE' || r.status === 'NEEDS REVIEW';
  }).map(function (r) {
    return trow([esc(r.loc), esc(r.rollId),
      r.expectedIn != null ? fmtLen(r.expectedIn) : '—',
      fmtLen(r.physicalIn),
      r.diffIn == null ? '—' : fmtDiff(r.diffIn),
      esc(r.status), esc(r.note || '—')]);
  }).join('');
  var docRows = docs.map(function (d) {
    return trow(['<b>' + esc(d.rollId) + '</b>', 'HISTORY CARD #' + d.num,
      esc(d.employee || '—'), d.at ? new Date(d.at).toLocaleString() : '—',
      esc(d.location || '—')]);
  }).join('');
  var html =
    '<div class="screen print-report">' +
    '<div class="noprint"><button class="backbtn" id="back">&larr; BACK</button>' +
    '<button class="btn btn-primary btn-huge" id="doprint">&#128438; PRINT / SAVE AS PDF</button></div>' +
    '<h1>FLOORGUARD &mdash; CYCLE COUNT MANAGER REPORT</h1>' +
    '<div class="sub">Generated ' + new Date().toLocaleString() + ' by ' + esc(DB.data.currentEmployee || '—') + '</div>' +
    '<h2>Session</h2>' +
    '<table class="ptable"><tbody>' +
    trow(['<b>Session ID</b>', esc(sessId)]) +
    trow(['<b>Employee</b>', esc(sess.startedBy || '—')]) +
    trow(['<b>Started</b>', sess.startedAt ? fmtDT(sess.startedAt) : '—']) +
    trow(['<b>Completed</b>', sess.endedAt ? fmtDT(sess.endedAt) : '—']) +
    trow(['<b>Duration</b>', fmtDur(m.totalMs)]) +
    '</tbody></table>' +
    '<h2>Pilot Metrics</h2>' +
    '<table class="ptable"><tbody>' +
    trow(['<b>Total Rolls Counted</b>', m.rolls]) +
    trow(['<b>Total Locations</b>', m.locations]) +
    trow(['<b>Average Count Time / Roll</b>', fmtDur(m.avgMs)]) +
    trow(['<b>Total Session Time</b>', fmtDur(m.totalMs)]) +
    trow(['<b>Discrepancies</b>', m.discrepancies]) +
    trow(['<b>Needs Review</b>', m.needsReview]) +
    trow(['<b>History Cards Digitized</b>', m.historyCards]) +
    '</tbody></table>' +
    '<h2>Count Results</h2>' +
    '<table class="ptable"><thead><tr><th>Location</th><th>Roll</th><th>Style</th><th>Color</th>' +
    '<th>Expected</th><th>Measured</th><th>Diff</th><th>MB</th><th>Hist. Card</th><th>Status</th><th>Time</th></tr></thead>' +
    '<tbody>' + (dataRows || trow(['<i>No rolls counted.</i>'])) + '</tbody></table>' +
    '<h2>Items Requiring Review</h2>' +
    '<table class="ptable"><thead><tr><th>Location</th><th>Roll</th><th>Expected</th><th>Measured</th>' +
    '<th>Diff</th><th>Status</th><th>Note</th></tr></thead>' +
    '<tbody>' + (discRows || trow(['<i>Nothing needs review.</i>'])) + '</tbody></table>' +
    '<h2>History Card Documents</h2>' +
    '<table class="ptable"><thead><tr><th>Roll ID</th><th>Document</th><th>Captured By</th><th>Captured At</th><th>Location</th></tr></thead>' +
    '<tbody>' + (docRows || trow(['<i>No history cards captured in this session.</i>'])) + '</tbody></table>' +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    $('#doprint').onclick = function () { window.print(); };
  }};
};

/* --- DISCOVERED ROLL DETAIL (§7 for never-before-seen rolls) --- */

/* ---- prototype lines 2318-2369 ---- */
function rollDiscoveredScreen(rollId) {
  var d = findDiscovered(rollId);
  if (!d) { setTimeout(function () { history.back(); }, 0); return { html: '' }; }
  var ddocs = docsForRoll(d.id);
  var counts = (FG().freeCounts || []).filter(function (c) { return c.rollId === d.id; })
    .sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  var countRows = counts.map(function (c) {
    return '<div class="trow"><div class="mono"><b>' + esc(c.location) + '</b></div>' +
      '<div class="num">' + fmtLen(c.physicalIn) + '</div>' +
      '<div>' + statusChip(freeCountStatus(c)) + '</div>' +
      '<div class="sub">' + esc(c.time) + '</div></div>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<button class="backbtn" id="back">&larr; BACK</button>' +
    '<div class="step-head">ROLL DETAIL &mdash; DISCOVERED</div>' +
    '<h1 class="mono">' + esc(d.id) + '</h1>' +
    '<div><span class="stchip st-blue">NEWLY DISCOVERED</span></div>' +
    '<div class="h2">Roll Information</div>' +
    '<div class="card">' +
    '<div class="kv"><span class="k">Barcode</span><span class="v mono">' + esc(d.id) + '</span></div>' +
    '<div class="kv"><span class="k">Current Location</span><span class="v mono">' + esc(d.lastLocation || '—') + '</span></div>' +
    '<div class="kv"><span class="k">Measured Balance</span><span class="v num">' +
      (d.lastMeasuredIn != null ? fmtLen(d.lastMeasuredIn) : '—') + ' ✓</span></div>' +
    '<div class="kv"><span class="k">Style / Color</span><span class="v" style="color:var(--muted)">NOT YET IMPORTED</span></div>' +
    '<div class="kv"><span class="k">First Seen</span><span class="v">' + esc(d.firstSeenBy || '—') + ' &middot; ' + fmtDT(d.firstSeenAt) + '</span></div>' +
    '</div>' +
    '<div class="h2">History Card Images</div>' +
    (ddocs.length ? docsHtml(ddocs) : '<div class="hint center">No history cards captured for this roll.</div>') +
    '<div class="h2">Cycle Counts</div>' +
    '<div class="thead trow"><div>LOCATION</div><div>MEASURED</div><div>STATUS</div><div>TIME</div></div>' +
    (countRows || '<div class="hint center">No counts recorded.</div>') +
    '</div>';
  return { html: html, mount: function () {
    $('#back').onclick = function () { history.back(); };
    wireDocViews();
  }};
};

/* ---------------- HISTORY CARD SCAN / DOCUMENT CAPTURE -------------------------
   Preserve the handwritten paper history cards attached to carpet rolls and
   connect each photo to the correct Roll ID inside FloorGuard.
   WORKFLOW: scan roll -> open roll record -> SCAN HISTORY CARD -> take photo ->
   USE PHOTO -> SAVE -> photo becomes part of the roll's permanent record.
   - Originals are never overwritten: each capture becomes HISTORY CARD #1, #2...
   - Capture uses a plain file-input camera picker, NOT the barcode scanners.
     The roll/location scanner implementations are untouched.
   - Optional smart extraction is review-first: nothing extracted is ever
     treated as confirmed data until a human taps CONFIRM; confirmed imports
     are labeled PAPER CARD IMPORT and never change expected balances.
   - Data source labels: FLOORGUARD (digital activity), PAPER CARD (the photo),
     PAPER CARD IMPORT (confirmed extracted data), REAL FLOORS (future API). */

/* ---- prototype lines 2370-2413 ---- */
var D = null; /* transient capture context; images live here until saved */

function newDocCapture(rollId, opts) {
  opts = opts || {};
  var roll = rollByBarcode(rollId);
  D = {
    rollId: String(rollId),
    barcode: roll ? roll.barcode : String(rollId || '').trim().toUpperCase(),
    discovered: !roll,
    location: opts.location || (roll ? roll.expectedLocation : '') || '',
    returnTo: opts.returnTo || null, /* {name, param} after a fresh save */
    image: null, thumb: null,
    docId: null, fresh: false, saveError: ''
  };
}
function docsForRoll(rollId) {
  return (FG().documents || []).filter(function (d) { return d.rollId === rollId; })
    .sort(function (a, b) { return a.at < b.at ? -1 : 1; });
}
function findDoc(id) {
  var ds = FG().documents || [];
  for (var i = 0; i < ds.length; i++) if (ds[i].id === id) return ds[i];
  return null;
}
/* Downscale a captured photo to a JPEG data URL so device-local storage stays
   small. The downscaled image IS the preserved original: it is written once
   and never re-compressed or overwritten afterwards. */
function downscaleImage(dataUrl, maxDim, quality, cb) {
  var img = new Image();
  img.onload = function () {
    try {
      var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      var cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cb(cv.toDataURL('image/jpeg', quality));
    } catch (e) { cb(null); }
  };
  img.onerror = function () { cb(null); };
  img.src = dataUrl;
}
/* Persist with real quota errors instead of DB.save()'s silent catch, so a
   full device tells the truth instead of pretending the photo was saved. */

/* ---- prototype lines 2414-2416 ---- */
function persistOrThrow() { DB.save(); }

/* ---- prototype lines 2419-2580 ---- */
Screens['roll/doc'] = function () {
  if (!D || !D.rollId) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var rt = D.returnTo;
  var html =
    '<div class="screen">' +
    '<div class="step-head">HISTORY CARD SCAN</div>' +
    '<div class="card" style="text-align:center">' +
      '<div class="label">HISTORY CARD FOR ROLL</div>' +
      '<div class="mono" style="font-size:2rem;font-weight:900">' + esc(D.rollId) + '</div>' +
      (D.discovered ? '<div><span class="stchip st-blue">DISCOVERED ROLL</span></div>' : '') +
    '</div>' +
    '<p class="hint">Photograph the handwritten paper history card attached to this roll. The photo becomes part of the roll&rsquo;s permanent record.</p>' +
    '<input type="file" id="docfile" accept="image/*" capture="environment" hidden>' +
    '<button class="btn btn-primary btn-huge" id="takephoto">&#128247; TAKE PHOTO</button>' +
    '<button class="btn btn-ghost" id="dccancel">CANCEL</button>' +
    '<div class="err" id="dcerr" hidden></div>' +
    '</div>';
  return { html: html, mount: function () {
    $('#takephoto').onclick = function () { $('#docfile').click(); };
    $('#dccancel').onclick = function () { D = null; if (rt) go(rt.name, rt.param); else history.back(); };
    $('#docfile').onchange = function () {
      var f = $('#docfile').files[0];
      if (!f) return;
      var e = $('#dcerr'); e.hidden = true;
      var rd = new FileReader();
      rd.onload = function () {
        downscaleImage(rd.result, 1280, 0.72, function (img) {
          if (!img) { bad(); e.textContent = 'Could not read that photo. Try again.'; e.hidden = false; return; }
          downscaleImage(rd.result, 320, 0.6, function (th) {
            D.image = img; D.thumb = th || img;
            good(); go('roll/doc/review');
          });
        });
      };
      rd.onerror = function () { bad(); e.textContent = 'Could not read that photo. Try again.'; e.hidden = false; };
      rd.readAsDataURL(f);
    };
  }};
};

/* --- STEP 2: review the photo, then USE PHOTO / RETAKE / CANCEL --- */
Screens['roll/doc/review'] = function () {
  if (!D || !D.image) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var html =
    '<div class="screen">' +
    '<div class="step-head">HISTORY CARD SCAN</div>' +
    '<h1>Review photo</h1>' +
    '<div class="card" style="text-align:center"><img src="' + D.image + '" style="max-width:100%;border-radius:8px"></div>' +
    '<div class="field"><label class="label" for="docloc">LOCATION (IF KNOWN)</label>' +
    '<input class="input mono" id="docloc" autocomplete="off" autocapitalize="characters" value="' + esc(D.location) + '" placeholder="e.g. 205B"></div>' +
    (D.saveError ? '<div class="err">' + esc(D.saveError) + '</div>' : '') +
    '<button class="btn btn-primary btn-huge" id="usephoto">&#10003; USE PHOTO</button>' +
    '<div class="btn-row">' +
      '<button class="btn" id="retake" style="flex:1">&#8635; RETAKE</button>' +
      '<button class="btn btn-ghost" id="dcancel2" style="flex:1">CANCEL</button>' +
    '</div>' +
    '</div>';
  return { html: html, mount: function () {
    $('#usephoto').onclick = function () {
      D.location = normLoc($('#docloc').value) || $('#docloc').value.trim();
      saveDocument();
    };
    $('#retake').onclick = function () { go('roll/doc'); };
    $('#dcancel2').onclick = function () {
      var rt = D.returnTo; D = null;
      if (rt) go(rt.name, rt.param); else history.back();
    };
  }};
};

function saveDocument() {
  var now = new Date();
  var rec = {
    id: 'D' + now.getTime().toString(36).toUpperCase(),
    rollId: D.rollId, barcode: D.barcode, raw: D.barcode,
    discovered: D.discovered,
    kind: 'HISTORY_CARD', docType: 'HISTORY CARD',
    image: D.image, thumb: D.thumb,
    employee: DB.data.currentEmployee,
    at: now.toISOString(), date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
    location: D.location || null,
    source: 'PAPER CARD',
    num: docsForRoll(D.rollId).length + 1,
    imports: [], /* confirmed smart-extractions, added later via doc-extract */
    /* Pilot session link: which count session this card was digitized in.
       Stamped only when a Free Run session is active; otherwise null. */
    sessionId: (typeof F !== 'undefined' && F && F.id && !F.endedAt) ? F.id : null
  };
  FG().documents.push(rec);
  try { persistOrThrow(); }
  catch (e) {
    /* Quota/full storage: roll the record back and say so on the review
       screen. The photo is NOT lost from the worker's hands — they can retry. */
    FG().documents.pop();
    bad();
    D.saveError = 'Device storage is full — the photo could not be saved. Free up space and tap USE PHOTO again.';
    return;
  }
  D.docId = rec.id; D.fresh = true;
  D.image = null; D.thumb = null; /* free the big in-memory strings */
  D.saveError = '';
  good();
  go('doc', rec.id);
}

/* --- Saved document: full record, VIEW ORIGINAL, optional extraction --- */
Screens['doc'] = function (param) {
  var doc = findDoc(param);
  if (!doc) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var imports = (doc.imports || []).map(function (imp) {
    return '<div class="card"><div class="kv"><span class="k">Status</span>' +
      '<span class="v"><span class="srcchip src-import">PAPER CARD IMPORT</span></span></div>' +
      importFieldsHtml(imp.fields) +
      '<div class="sub">Confirmed by ' + esc(imp.confirmedBy) + ' &middot; ' + fmtDT(imp.confirmedAt) + '</div></div>';
  }).join('');
  var freshContinue = D && D.fresh && D.docId === doc.id && D.returnTo;
  var html =
    '<div class="screen">' +
    '<div class="step-head">ROLL DOCUMENT</div>' +
    '<h1 class="mono">HISTORY CARD #' + doc.num + '</h1>' +
    '<div class="card" style="text-align:center">' +
      '<img src="' + doc.thumb + '" id="docimg" style="max-width:100%;border-radius:8px">' +
      '<br><button class="btn" id="vieworig" style="margin-top:10px">&#128269; VIEW ORIGINAL</button>' +
    '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll</span><span class="v mono">' + esc(doc.rollId) + '</span></div>' +
      '<div class="kv"><span class="k">Document Type</span><span class="v">' + esc(doc.docType) + '</span></div>' +
      '<div class="kv"><span class="k">Captured</span><span class="v">' + esc(doc.date) + ' &middot; ' + esc(doc.time) + '</span></div>' +
      '<div class="kv"><span class="k">Employee</span><span class="v">' + esc(doc.employee) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(doc.location || '&mdash;') + '</span></div>' +
      '<div class="kv"><span class="k">Source</span><span class="v"><span class="srcchip">PAPER CARD</span></span></div>' +
    '</div>' +
    imports +
    '<button class="btn btn-huge" id="extract">&#10024; EXTRACT HISTORY FROM CARD</button>' +
    (freshContinue
      ? '<button class="btn btn-primary btn-huge" id="doccontinue">CONTINUE &rarr;</button>'
      : '<button class="btn btn-ghost" id="docback">&larr; BACK</button>') +
    '<div id="docoverlay" class="doc-overlay" hidden><img id="docfull" alt="History card original"><div class="hint" style="color:#fff">Tap to close</div></div>' +
    '</div>';
  return { html: html, mount: function () {
    $('#vieworig').onclick = function () {
      $('#docfull').src = doc.image;
      $('#docoverlay').hidden = false;
    };
    $('#docoverlay').onclick = function () { $('#docoverlay').hidden = true; $('#docfull').removeAttribute('src'); };
    $('#extract').onclick = function () { go('doc/extract', doc.id); };
    if (freshContinue) {
      $('#doccontinue').onclick = function () { var rt = D.returnTo; D = null; go(rt.name, rt.param); };
    } else {
      $('#docback').onclick = function () { history.back(); };
    }
  }};
};

/* --- OPTIONAL SMART EXTRACTION ------------------------------------------------
   Prototype feature "EXTRACT HISTORY FROM CARD". extractFromImage() is the
   single seam where a future OCR engine plugs in. This build ships with no
   OCR engine (offline-first; no heavy deps), so auto-read reports unavailable
   and the worker reads the card and enters values — the review screen,
   UNVERIFIED labeling, and CONFIRM / EDIT / IGNORE workflow are identical
   either way. Nothing extracted ever becomes confirmed data without CONFIRM,
   and confirmed imports NEVER change expected balances. */

/* ---- prototype lines 2581-2602 ---- */
function extractFromImage(dataUrl) {
  return {
    available: false,
    fields: null,
    note: 'Auto-read is not available in this prototype build — read the card above and enter the values below.'
  };
}
function readExtractFields() {
  function num(id) { var v = parseFloat(($('#' + id).value || '').trim()); return isNaN(v) ? null : v; }
  function ftin(ftId, inId) {
    var ft = num(ftId), inch = num(inId);
    if (ft == null && inch == null) return null;
    return { ft: ft || 0, inch: inch || 0, totalIn: Math.round((ft || 0) * 12 + (inch || 0)) };
  }
  return {
    job: $('#xjob').value.trim(), order: $('#xorder').value.trim(),
    cut: ftin('xcutft', 'xcutin'), balance: ftin('xbalft', 'xbalin'),
    measured: ftin('xmbft', 'xmbin'),
    date: $('#xdate').value.trim(), size: $('#xsize').value.trim(),
    notes: $('#xnotes').value.trim()
  };
}

/* ---- prototype lines 2603-2694 ---- */
function importFieldsHtml(f) {
  var rows = [];
  if (f.job) rows.push(['Job Number', esc(f.job)]);
  if (f.order) rows.push(['Order Number', esc(f.order)]);
  if (f.cut) rows.push(['Cut', '<span class="num">' + fmtLen(f.cut.totalIn) + '</span>']);
  if (f.balance) rows.push(['Balance', '<span class="num">' + fmtLen(f.balance.totalIn) + '</span>']);
  if (f.measured) rows.push(['Measured Balance', '<span class="num">' + fmtLen(f.measured.totalIn) + '</span> <span class="stchip st-green">MB &#10003;</span>']);
  if (f.date) rows.push(['Date', esc(f.date)]);
  if (f.size) rows.push(['Size', esc(f.size)]);
  if (f.notes) rows.push(['Notes', esc(f.notes)]);
  if (!rows.length) return '<div class="sub">No values entered.</div>';
  return rows.map(function (r) {
    return '<div class="kv"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>';
  }).join('');
}
Screens['doc/extract'] = function (param) {
  var doc = findDoc(param);
  if (!doc) { setTimeout(function () { go('dashboard'); }, 0); return { html: '' }; }
  var ext = extractFromImage(doc.image);
  var pre = function (v) { return esc(v || ''); };
  var pf = ext.fields || {};
  var html =
    '<div class="screen">' +
    '<div class="step-head">HISTORY CARD SCAN</div>' +
    '<h1>Extract history</h1>' +
    '<div class="card" style="border:2px solid var(--yellow)">' +
      '<div style="font-weight:900;color:var(--yellow)">&#9888; UNVERIFIED IMPORTED HISTORY</div>' +
      '<div class="hint">Handwriting reads may be imperfect. Nothing here is confirmed data — review every field before confirming.</div>' +
      (ext.available ? '' : '<div class="hint">' + esc(ext.note) + '</div>') +
    '</div>' +
    '<div class="card" style="text-align:center"><img src="' + doc.thumb + '" style="max-width:100%;border-radius:8px"></div>' +
    '<div class="field"><label class="label" for="xjob">JOB NUMBER</label><input class="input mono" id="xjob" autocomplete="off" value="' + pre(pf.job) + '"></div>' +
    '<div class="field"><label class="label" for="xorder">ORDER NUMBER</label><input class="input mono" id="xorder" autocomplete="off" value="' + pre(pf.order) + '"></div>' +
    '<div class="label">CUT AMOUNT</div><div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label" for="xcutft">FEET</label><input class="input num" id="xcutft" inputmode="numeric" autocomplete="off" value="' + pre(pf.cutFt) + '"></div>' +
      '<div class="field" style="flex:1"><label class="label" for="xcutin">INCHES</label><input class="input num" id="xcutin" inputmode="decimal" autocomplete="off" value="' + pre(pf.cutIn) + '"></div></div>' +
    '<div class="label">BALANCE</div><div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label" for="xbalft">FEET</label><input class="input num" id="xbalft" inputmode="numeric" autocomplete="off" value="' + pre(pf.balFt) + '"></div>' +
      '<div class="field" style="flex:1"><label class="label" for="xbalin">INCHES</label><input class="input num" id="xbalin" inputmode="decimal" autocomplete="off" value="' + pre(pf.balIn) + '"></div></div>' +
    '<div class="label">MEASURED BALANCE (MB)</div><div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label" for="xmbft">FEET</label><input class="input num" id="xmbft" inputmode="numeric" autocomplete="off" value="' + pre(pf.mbFt) + '"></div>' +
      '<div class="field" style="flex:1"><label class="label" for="xmbin">INCHES</label><input class="input num" id="xmbin" inputmode="decimal" autocomplete="off" value="' + pre(pf.mbIn) + '"></div></div>' +
    '<div class="field"><label class="label" for="xdate">DATE (ON CARD)</label><input class="input" id="xdate" autocomplete="off" value="' + pre(pf.date) + '"></div>' +
    '<div class="field"><label class="label" for="xsize">SIZE</label><input class="input" id="xsize" autocomplete="off" value="' + pre(pf.size) + '"></div>' +
    '<div class="field"><label class="label" for="xnotes">NOTES</label><textarea class="input" id="xnotes" rows="3">' + pre(pf.notes) + '</textarea></div>' +
    '<button class="btn btn-primary btn-huge" id="xconfirm">&#10003; CONFIRM IMPORT</button>' +
    '<div class="btn-row">' +
      '<button class="btn" id="xedit" style="flex:1">&#9998; EDIT</button>' +
      '<button class="btn btn-ghost" id="xignore" style="flex:1">IGNORE</button>' +
    '</div>' +
    '</div>';
  return { html: html, mount: function () {
    $('#xedit').onclick = function () { $('#xjob').focus(); };
    $('#xignore').onclick = function () { history.back(); };
    $('#xconfirm').onclick = function () {
      var now = new Date();
      doc.imports.push({
        id: 'X' + now.getTime().toString(36).toUpperCase(),
        docId: doc.id,
        fields: readExtractFields(),
        status: 'CONFIRMED',
        confirmedAt: now.toISOString(),
        confirmedBy: DB.data.currentEmployee
      });
      DB.save();
      good();
      go('doc', doc.id);
    };
  }};
};

/* DOCUMENTS section for the Roll History screen. */
function docsHtml(docs) {
  return docs.map(function (d) {
    return '<div class="ledger-row"><img class="doc-thumb" src="' + d.thumb + '" alt="History card thumbnail">' +
      '<div class="what"><b>HISTORY CARD #' + d.num + '</b> <span class="srcchip">PAPER CARD</span>' +
      '<div class="sub">' + esc(d.date) + ' &middot; ' + esc(d.employee) +
      (d.location ? ' &middot; loc <span class="mono">' + esc(d.location) + '</span>' : '') +
      ((d.imports || []).length ? ' &middot; ' + d.imports.length + ' import' + (d.imports.length > 1 ? 's' : '') : '') +
      '</div></div>' +
      '<div class="bal"><button class="btn btn-xs" data-docview="' + esc(d.id) + '">VIEW</button></div></div>';
  }).join('');
}

/* Wire every "VIEW DOCUMENT" / "VIEW" button rendered by ledgerHtml/docsHtml. */
function wireDocViews() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-docview]'), function (b) {
    b.onclick = function () { go('doc', b.getAttribute('data-docview')); };
  });
}

/* ---------------- RAPID CYCLE COUNT ----------------------------------------------

/* ---- prototype lines 2700-2902 ---- */
Screens['count/rapid/loc'] = function () {
  if (!R) newRapid();
  var chips = ['205A', '205B', '206A', '206B', '204A', '204B'].map(function (l) {
    return '<button class="demochip" data-code="' + esc(l) + '">' + esc(l) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">RAPID CYCLE COUNT &mdash; STEP 1</div>' +
    '<h1>Scan location</h1>' +
    '<p class="hint">Scan the rack location tag. Every roll you scan after this is counted at that location until you change it.</p>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE LOCATION CODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. 205B">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
  }};
  function onCode(code) {
    var loc = normLoc(code);
    if (!loc) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; EMPTY SCAN &mdash; try again.</div>';
      return;
    }
    good();
    R.activeLoc = loc;
    R.lastMsg = null;
    go('count/rapid/scan');
  }
};

function rapidBanner() {
  var m = R && R.lastMsg;
  if (!m) return '';
  var color = { MATCH: 'var(--green)', SHORT: 'var(--red)', OVER: 'var(--yellow)',
                LOCATION_MISMATCH: 'var(--red)', NEEDS_REVIEW: 'var(--yellow)' }[m.status] || 'var(--yellow)';
  return '<div class="card" style="border:2px solid ' + color + ';text-align:center">' +
    '<div style="font-size:1.4rem;font-weight:900;color:' + color + '">' + esc(m.text) + '</div></div>';
}

Screens['count/rapid/scan'] = function () {
  if (!R || !R.activeLoc) { setTimeout(function () { go('count/rapid/loc'); }, 0); return { html: '' }; }
  var chips = FG().rolls.map(function (r) {
    return '<button class="demochip" data-code="' + esc(r.barcode) + '">' + esc(r.barcode) + '</button>';
  }).join('');
  var html =
    '<div class="screen">' +
    '<div class="step-head">RAPID CYCLE COUNT</div>' +
    '<div class="card" style="text-align:center">' +
      '<div class="label">COUNTING LOCATION</div>' +
      '<div class="mono" style="font-size:2.4rem;font-weight:900">' + esc(R.activeLoc) + '</div>' +
    '</div>' +
    rapidBanner() +
    '<h1>Scan roll</h1>' +
    '<div class="cambox" id="cambox"><div class="camnote">Starting camera&hellip;</div></div>' +
    '<form id="manualform"><div class="field">' +
      '<label class="label" for="manual">OR TYPE / WEDGE THE BARCODE</label>' +
      '<input class="input mono" id="manual" autocomplete="off" autocapitalize="characters" placeholder="e.g. QH5CPHN">' +
    '</div>' +
    '<button class="btn btn-primary btn-huge" type="submit">ENTER CODE</button></form>' +
    '<div class="demolabel">DEMO &mdash; TAP TO SIMULATE A SCAN</div>' +
    '<div class="demochips">' + chips + '</div>' +
    '<div id="result"></div>' +
    '<div class="btn-row">' +
      '<button class="btn" id="changeloc" style="flex:1">&#8646; CHANGE LOCATION</button>' +
      '<button class="btn" id="rapiddone" style="flex:1">DONE</button>' +
    '</div>' +
    '</div>';
  return { html: html, mount: function () {
    mountScannerBox('cambox', onCode);
    $('#manualform').onsubmit = function (e) { e.preventDefault(); onCode($('#manual').value); };
    Array.prototype.forEach.call(document.querySelectorAll('.demochip'), function (c) {
      c.onclick = function () { onCode(c.getAttribute('data-code')); };
    });
    $('#changeloc').onclick = function () { go('count/rapid/loc'); };
    $('#rapiddone').onclick = function () { R = null; go('dashboard'); };
  }};
  function onCode(code) {
    var roll = rollByBarcode(code);
    if (!roll) {
      bad();
      $('#result').innerHTML = '<div class="err center" style="font-size:1.3rem">&#10060; ROLL NOT FOUND<br><span style="font-size:1rem">"' +
        esc(code) + '" is not in the system. Try again.</span></div>';
      return;
    }
    good();
    R.scan = { roll: roll };
    if (normLoc(roll.expectedLocation) !== normLoc(R.activeLoc)) go('count/rapid/mismatch');
    else go('count/rapid/balance');
  }
};

Screens['count/rapid/mismatch'] = function () {
  if (!R || !R.scan || !R.scan.roll) { setTimeout(function () { go('count/rapid/scan'); }, 0); return { html: '' }; }
  var roll = R.scan.roll;
  var html =
    '<div class="screen">' +
    '<div class="warn-panel"><h1>&#9888; LOCATION MISMATCH</h1>' +
    '<div class="vs"><div><div class="k">EXPECTED</div><div class="v mono">' + esc(roll.expectedLocation) + '</div></div>' +
    '<div><div class="k">COUNT LOCATION</div><div class="v mono">' + esc(R.activeLoc) + '</div></div></div></div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
    '</div>' +
    '<p class="hint">This roll does not belong at <b class="mono">' + esc(R.activeLoc) + '</b>. Flag it for supervisor review, or cancel and keep counting.</p>' +
    '<button class="btn btn-red btn-huge" id="flag">&#9888; FLAG FOR REVIEW</button>' +
    '<button class="btn btn-huge" id="cancel">CANCEL &rarr; KEEP COUNTING</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#flag').onclick = function () {
      var now = new Date();
      FG().counts.push({
        id: 'C' + Date.now().toString(36).toUpperCase(),
        rollId: roll.id, barcode: roll.barcode, style: roll.style, color: roll.color, widthIn: roll.widthIn,
        expectedLocation: roll.expectedLocation, scannedLocation: R.activeLoc,
        expectedIn: systemBalance(roll.id), physicalIn: null, diffIn: null,
        measured: false, /* no physical measurement taken — mismatch flagged only */
        employee: DB.data.currentEmployee, at: now.toISOString(),
        date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
        status: 'LOCATION_MISMATCH', flagged: true
      });
      DB.save();
      bad();
      R.lastMsg = { status: 'LOCATION_MISMATCH', text: '⚠ MISMATCH — ' + roll.id + ' flagged for review' };
      R.scan = null;
      go('count/rapid/scan');
    };
    $('#cancel').onclick = function () { R.scan = null; go('count/rapid/scan'); };
  }};
};

Screens['count/rapid/balance'] = function () {
  if (!R || !R.scan || !R.scan.roll) { setTimeout(function () { go('count/rapid/scan'); }, 0); return { html: '' }; }
  var roll = R.scan.roll, sys = systemBalance(roll.id);
  var html =
    '<div class="screen">' +
    '<div class="step-head">RAPID CYCLE COUNT &mdash; ' + esc(R.activeLoc) + '</div>' +
    '<div class="card">' +
      '<div class="kv"><span class="k">Roll #</span><span class="v mono">' + esc(roll.id) + '</span></div>' +
      '<div class="kv"><span class="k">Style</span><span class="v">' + esc(roll.style) + '</span></div>' +
      '<div class="kv"><span class="k">Color</span><span class="v">' + esc(roll.color) + '</span></div>' +
      '<div class="kv"><span class="k">Location</span><span class="v mono">' + esc(R.activeLoc) + '</span></div>' +
      '<div class="kv"><span class="k">EXPECTED BALANCE' +
        (isTestBalance(roll) ? ' <span class="stchip st-yellow">TEST</span>' : '') +
        '</span><span class="v num" style="font-size:2rem">' + fmtLen(sys) + '</span></div>' +
    '</div>' +
    '<div class="btn-row">' +
      '<div class="field" style="flex:1"><label class="label">FEET</label>' +
      '<input class="input num" id="rft" inputmode="numeric" autocomplete="off" placeholder="0" style="font-size:2.2rem;min-height:84px;text-align:center"></div>' +
      '<div class="field" style="flex:1"><label class="label">INCHES</label>' +
      '<input class="input num" id="rin" inputmode="decimal" autocomplete="off" placeholder="0" style="font-size:2.2rem;min-height:84px;text-align:center"></div>' +
    '</div>' +
    '<div class="err" id="rerr" hidden></div>' +
    '<button class="btn btn-primary btn-huge" id="savenext">&#10003; SAVE &amp; NEXT</button>' +
    '<button class="btn" id="rback">&larr; BACK TO SCANNER</button>' +
    '</div>';
  return { html: html, mount: function () {
    $('#rback').onclick = function () { R.scan = null; go('count/rapid/scan'); };
    $('#savenext').onclick = function () {
      var ft = parseFloat($('#rft').value), inch = parseFloat($('#rin').value);
      var err = '';
      if ($('#rft').value.trim() === '' && $('#rin').value.trim() === '') err = 'Enter feet and/or inches.';
      else if (isNaN(ft) || isNaN(inch) || ft < 0 || inch < 0) err = 'Numbers must be zero or more.';
      if (err) { bad(); var e = $('#rerr'); e.textContent = err; e.hidden = false; return; }
      var physicalIn = Math.round(ft * 12 + inch);
      var diff = physicalIn - sys;
      var status = computeStatus(roll, R.activeLoc, physicalIn, false);
      var now = new Date();
      FG().counts.push({
        id: 'C' + Date.now().toString(36).toUpperCase(),
        rollId: roll.id, barcode: roll.barcode, style: roll.style, color: roll.color, widthIn: roll.widthIn,
        expectedLocation: roll.expectedLocation, scannedLocation: R.activeLoc,
        expectedIn: sys, physicalIn: physicalIn, diffIn: diff,
        measured: true, /* MB: worker physically measured this roll */
        employee: DB.data.currentEmployee, at: now.toISOString(),
        date: now.toLocaleDateString(), time: fmtTime(now.toISOString()),
        status: status, flagged: false
      });
      roll.measuredIn = physicalIn;
      roll.measuredAt = now.toISOString();
      roll.measuredBy = DB.data.currentEmployee;
      DB.save();
      if (status === 'MATCH') good(); else bad();
      var sym = status === 'MATCH' ? '✓' : (status === 'SHORT' ? '▼' : '▲');
      R.lastMsg = { status: status, text: sym + ' ' + status + ' ' + fmtDiff(diff) + ' — ' + roll.id };
      R.scan = null;
      go('count/rapid/scan'); /* straight back to the scanner — never home */
    };
  }};
};

/* ---------------- SUPERVISOR DASHBOARD ------------------------------------------- */

/* ---- prototype lines 2903-2999 ---- */
Screens['reports'] = function () {
  var today = FG().counts.filter(function (c) { return isToday(c.at); });
  var n = function (s) { return today.filter(function (c) { return c.status === s; }).length; };
  var seen = {}, recounts = 0;
  today.forEach(function (c) {
    if (seen[c.rollId]) { if (seen[c.rollId] === 1) recounts++; seen[c.rollId]++; }
    else seen[c.rollId] = 1;
  });
  var last = today.slice().sort(function (a, b) { return new Date(b.at) - new Date(a.at); })[0];
  var byEmp = {};
  today.forEach(function (c) { byEmp[c.employee] = (byEmp[c.employee] || 0) + 1; });
  var empRows = Object.keys(byEmp).sort().map(function (e) {
    return '<div class="kv"><span class="k">' + esc(e) + '</span><span class="v num">' + byEmp[e] + '</span></div>';
  }).join('') || '<p class="hint">No counts today.</p>';

  var chips = ['MATCH', 'SHORT', 'OVER', 'LOCATION_MISMATCH', 'NEEDS_REVIEW'].map(function (s) {
    return '<button class="fchip" data-f="' + s + '">' + STATUS[s].label + '</button>';
  }).join('');

  var html =
    '<div class="screen">' +
    '<div class="step-head">SUPERVISOR</div>' +
    '<h1>Dashboard &mdash; today</h1>' +
    '<div class="metric-grid">' +
      metric(today.length, 'ROLLS COUNTED') +
      metric(n('MATCH'), 'MATCHES') +
      metric(n('SHORT'), 'SHORTAGES', today.length && n('SHORT') ? 'alert' : '') +
      metric(n('OVER'), 'OVERAGES') +
      metric(n('LOCATION_MISMATCH'), 'LOCATION MISMATCH', n('LOCATION_MISMATCH') ? 'alert' : '') +
      metric(n('NEEDS_REVIEW'), 'NEEDS REVIEW', n('NEEDS_REVIEW') ? 'warnb' : '') +
      metric(recounts, 'RECOUNTS') +
      '<div class="metric"><div class="n" style="font-size:1.2rem">' + (last ? fmtTime(last.at) : '&mdash;') + '</div><div class="l">LAST COUNT TIME</div></div>' +
    '</div>' +
    '<h2>Counts by employee</h2><div class="card">' + empRows + '</div>' +
    '<button class="btn btn-huge" id="godisc">&#9888; CYCLE COUNT DISCREPANCIES' +
    (discrepancyRolls().length ? ' (' + discrepancyRolls().length + ')' : '') + '</button>' +
    '<h2>Search &amp; filter</h2>' +
    '<div class="field"><input class="input" id="dq" autocomplete="off" placeholder="Roll, location, style, color, employee, date&hellip;"></div>' +
    '<div class="chiprow" id="dchips"><button class="fchip on" data-f="">ALL</button>' + chips + '</div>' +
    '<div id="dresults"></div>' +
    '<h2>Pilot setup</h2>' +
    '<div class="card">' +
      '<button class="btn btn-red btn-huge" id="resetcounts">RESET TEST DATA</button>' +
      '<p class="hint">Reset test data clears <b>cycle counts and measured-balance (MB) markers</b> &mdash; rolls, cuts, history cards, Free Run data, test balances, and the barcode scanner are untouched.</p>' +
    '</div>' +
    '<div class="foot"><button class="linklike" id="resetdemo">Reset demo data</button></div>' +
    '</div>';
  return { html: html, mount: function () {
    var f = '';
    var apply = function () {
      var q = $('#dq').value.trim().toLowerCase();
      var list = today.filter(function (c) {
        if (f && c.status !== f) return false;
        if (!q) return true;
        return (c.rollId + ' ' + c.scannedLocation + ' ' + c.expectedLocation + ' ' +
                c.style + ' ' + c.color + ' ' + c.employee + ' ' + fmtDT(c.at)).toLowerCase().indexOf(q) >= 0;
      }).sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
      $('#dresults').innerHTML = list.length ? list.map(countRow).join('') : '<p class="hint center">No matching counts today.</p>';
      wireCountRows();
    };
    $('#dq').addEventListener('input', apply);
    Array.prototype.forEach.call(document.querySelectorAll('#dchips .fchip'), function (b) {
      b.onclick = function () {
        f = b.getAttribute('data-f');
        Array.prototype.forEach.call(document.querySelectorAll('#dchips .fchip'), function (x) {
          x.classList.toggle('on', x === b);
        });
        apply();
      };
    });
    $('#resetdemo').onclick = function () {
      if (confirm('Reset all demo data to the seeded sample?')) { FGReset(); good(); render(); }
    };
    $('#godisc').onclick = function () { go('count/review'); };
    $('#resetcounts').onclick = function () {
      var n = FG().counts.length;
      if (n === 0) { alert('No cycle counts to clear.'); return; }
      if (confirm('RESET TEST DATA?\n\nThis clears ' + n + ' saved cycle count' + (n === 1 ? '' : 's') + ' and all measured-balance (MB) markers.\n\nRoll data, cuts, test system balances, and the barcode scanner are NOT affected.\nThis cannot be undone.')) {
        FG().counts = [];
        FG().rolls.forEach(function (r) { r.measuredIn = null; r.measuredAt = null; r.measuredBy = null; });
        DB.save();
        good(); render();
      }
    };
    apply();
  }};
  function metric(num, label, cls) {
    return '<div class="metric ' + (cls || '') + '"><div class="n num">' + num + '</div><div class="l">' + label + '</div></div>';
  }
};

/* ---------------- CYCLE COUNT DISCREPANCIES (supervisor) ---------------------------
   Shows only rolls whose latest physically-measured balance differs from the
   expected balance. Discrepancies are recorded for review — reviewing never
   changes the expected balance; that only happens through cut transactions. */

/* ---- prototype lines 3000-3024 ---- */
Screens['count/review'] = function () {
  var rows = discrepancyRolls();
  var html =
    '<div class="screen">' +
    '<div class="step-head">SUPERVISOR</div>' +
    '<h1>Cycle count discrepancies</h1>' +
    '<p class="hint">Rolls where the last <b>measured</b> balance (MB ✓) differs from the expected balance. ' +
    'Review only &mdash; expected balances change through cut transactions, never here.</p>' +
    (rows.length ? rows.map(function (c) {
      return '<button class="rowbtn" data-count="' + esc(c.id) + '">' +
        '<div class="rhead"><b class="mono">' + esc(c.rollId) + '</b>' + statusChip(c.status) +
        ' <span class="stchip st-green">MB ✓</span></div>' +
        '<div class="sub">loc <b class="mono">' + esc(c.scannedLocation) + '</b> &middot; ' + esc(c.employee) + ' &middot; ' + esc(c.time || fmtTime(c.at)) + '</div>' +
        '<div class="sub num">Exp <b>' + fmtLen(c.expectedIn) + '</b> &middot; Meas <b>' + fmtLen(c.physicalIn) + '</b>' +
        ' &middot; Diff <b class="' + diffCls(c.diffIn) + '">' + fmtDiff(c.diffIn) + '</b></div></button>';
    }).join('') : '<p class="hint center">No discrepancies &mdash; every measured roll matches.</p>') +
    '</div>';
  return { html: html, mount: function () { wireCountRows(); } };
};

/* ---------------- boot ---------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', function () {
  DB.load();
  render();
});
