#!/usr/bin/env node
/* tests/run9-pg.test.js — Run 9 PostgreSQL validation suite.
 *
 * Rebuilds a throwaway database from zero (shim + migrations 0001–0015 +
 * role seed), then validates:
 *   1. Migration chain + schema version + function least-privilege (0015)
 *   2. Server-side remnant compatibility + supervisor override (0010)
 *   3. Authorization hardening (0011) + cut-consumption flag (0013)
 *   4. Four-role RPC matrix (EMPLOYEE / SUPERVISOR / MANAGER / ADMIN)
 *   5. Functional matrix (cuts, idempotency, reservations, cycle counts,
 *      orders → SO → WO, loadout, receipts, returns, restock)
 *   6. return_restock atomicity matrix (9 cases)
 *   7. Deterministic concurrency (cut, reservation, restock, order, SO, loadout)
 *   8. Two-warehouse RLS isolation
 *   9. Private document-storage policies
 *
 * Requires: local PostgreSQL with a superuser accessible via
 * `sudo -u postgres psql` (for the rebuild), and the test login role.
 * Env overrides: FG_PG_DB, FG_PG_USER, FG_PG_PASS, FG_PG_HOST.
 * Exit code 0 = all pass, 1 = any failure.
 */
'use strict';
const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB = process.env.FG_PG_DB || 'floorguard_run9';
const PGUSER = process.env.FG_PG_USER || 'test_app';
const PGPASS = process.env.FG_PG_PASS || 'test_app_pw';
const PGHOST = process.env.FG_PG_HOST || 'localhost';

// Stable role identities (tests/pg/seed_roles.sql).
const EMP_A = '11111111-1111-1111-1111-111111111111';
const SUP_A = '22222222-2222-2222-2222-222222222222';
const MGR_A = '33333333-3333-3333-3333-333333333333';
const ADM_A = '44444444-4444-4444-4444-444444444444';
const EMP_B = '55555555-5555-5555-5555-555555555555';
const SUP_B = '66666666-6666-6666-6666-666666666666';

let pass = 0, fail = 0;
const failures = [];
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { pass++; console.log('  ok - ' + name); },
        e => { fail++; failures.push(name + ' :: ' + (e && e.message)); console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }));
    } else { pass++; console.log('  ok - ' + name); }
  }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL - ' + name + ' :: ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ---------- low-level DB access ----------
function superSql(sql) {
  return execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', DB, '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
// Run SQL as the app login role with a chosen JWT subject (role impersonation).
function userSql(uuid, sql) {
  const full = `SET request.jwt.claim.sub='${uuid}';\n${sql}`;
  try {
    return execFileSync('psql',
      ['-h', PGHOST, '-U', PGUSER, '-d', DB, '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', full],
      { encoding: 'utf8', env: Object.assign({}, process.env, { PGPASSWORD: PGPASS }), maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    const out = (e.stdout || '') + '\n' + (e.stderr || '');
    const err = new Error('PSQL_ERROR: ' + out.trim().split('\n').slice(-4).join(' | '));
    err.pgout = out;
    throw err;
  }
}
function userSqlAsync(uuid, sql) {
  const full = `SET request.jwt.claim.sub='${uuid}';\n${sql}`;
  return new Promise((resolve, reject) => {
    execFile('psql', ['-h', PGHOST, '-U', PGUSER, '-d', DB, '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', full],
      { encoding: 'utf8', env: Object.assign({}, process.env, { PGPASSWORD: PGPASS }), maxBuffer: 64 * 1024 * 1024 },
      (e, stdout, stderr) => e ? reject(new Error('PSQL_ERROR: ' + ((stdout || '') + '\n' + (stderr || '')).trim().split('\n').slice(-3).join(' | '))) : resolve(stdout.trim()));
  });
}
// Call an RPC, return parsed jsonb. Throws with PSQL_ERROR on raise.
function rpc(uuid, call) {
  const raw = userSql(uuid, `SELECT public.${call};`);
  const line = raw.split('\n').filter(l => l && l !== 'SET').join('\n').trim();
  try { return JSON.parse(line); }
  catch (e) { throw new Error('could not parse RPC result: ' + line.slice(0, 200)); }
}
function rpcErrCode(uuid, call) {
  try { rpc(uuid, call); return null; }
  catch (e) {
    const m = /PSQL_ERROR: (.*)/.exec(e.message);
    const tail = m ? m[1] : e.message;
    const code = /'([A-Z_]+)'/.exec(tail);
    return code ? code[1] : tail.slice(0, 120);
  }
}
// For RPCs that signal denial via return_fail(): returns r.error.code (or 'RAISED:<code>' for hard raises).
function rpcDenyCode(uuid, call) {
  try {
    const r = rpc(uuid, call);
    if (r && r.ok === false && r.error && r.error.code) return r.error.code;
    if (r && r.ok === true) return 'ALLOWED';
    return 'UNEXPECTED:' + JSON.stringify(r).slice(0, 120);
  } catch (e) { return 'RAISED:' + rpcErrCode(uuid, call); }
}
function scalar(uuid, sql) {
  const raw = userSql(uuid, sql);
  return raw.split('\n').filter(l => l && l !== 'SET').join('\n').trim();
}

// ---------- rebuild ----------
function rebuild() {
  console.log('rebuilding database ' + DB + ' from zero (shim + 0001-0015 + seed)...');
  execFileSync('sudo', ['-u', 'postgres', 'psql', '-t', '-A', '-c',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB}' AND pid <> pg_backend_pid();`],
    { encoding: 'utf8' });
  execFileSync('sudo', ['-u', 'postgres', 'psql', '-q', '-c', `DROP DATABASE IF EXISTS ${DB};`], { encoding: 'utf8' });
  execFileSync('sudo', ['-u', 'postgres', 'psql', '-q', '-c', `CREATE DATABASE ${DB};`], { encoding: 'utf8' });
  const files = ['tests/pg/harness_shim.sql'];
  for (let i = 1; i <= 15; i++) files.push(`supabase/migrations/${String(i).padStart(4, '0')}_*.sql`);
  files.push('tests/pg/seed_roles.sql');
  for (const pat of files) {
    const matches = execFileSync('bash', ['-c', `ls ${ROOT}/${pat} 2>/dev/null`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    assert(matches.length > 0, 'migration file missing for pattern ' + pat);
    // postgres cannot read /home/hatch — stage each file world-readable in /tmp first.
    for (const f of matches) {
      const dest = `/tmp/fg_run9_pg_${f.split('/').pop()}`;
      execFileSync('bash', ['-c', `cp ${f} ${dest} && chmod 644 ${dest}`], { encoding: 'utf8' });
      execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1', '-f', dest], { encoding: 'utf8' });
    }
  }
  // Test login role (idempotent).
  superSql(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${PGUSER}') THEN
    CREATE ROLE ${PGUSER} LOGIN PASSWORD '${PGPASS}'; END IF; END $$;`);
  superSql(`GRANT ${PGUSER} TO postgres; GRANT authenticated TO ${PGUSER};`);
  console.log('rebuild complete.');
}

// ---------- fixtures (superuser: bypasses RLS) ----------
let seq = 0;
function nid(p) { seq++; return `${p}-${seq}-${Date.now().toString(36)}`; }
const Q = s => `'${String(s).replace(/'/g, "''")}'`;
function mkRoll(id, wh, bal, style, color, loc) {
  superSql(`INSERT INTO public.rolls (id, barcode, warehouse_id, style, color, material_type, width_in, beginning_in, expected_in, location_code)
    VALUES (${Q(id)}, ${Q('BC-' + id)}, ${Q(wh)}, ${Q(style || '')}, ${Q(color || '')}, 'CARPET', 144, ${bal}, ${bal}, ${Q(loc || '205B')});`);
}
function mkSession(id, wh) {
  superSql(`INSERT INTO public.cycle_count_sessions (id, warehouse_id, mode, status, employee_id, employee_name)
    VALUES (${Q(id)}, ${Q(wh)}, 'STANDARD', 'ACTIVE', 'U-EMP-A', 'Eddie') ON CONFLICT (id) DO NOTHING;`);
}
function mkWO(id, wh, num) {
  superSql(`INSERT INTO public.work_orders (id, number, warehouse_id, status) VALUES (${Q(id)}, ${Q(num)}, ${Q(wh)}, 'OPEN');`);
}
function mkLine(id, woId, style, color, reqIn) {
  superSql(`INSERT INTO public.work_order_material_lines (id, work_order_id, material_type, style, color, width_in, required_in)
    VALUES (${Q(id)}, ${Q(woId)}, 'CARPET', ${Q(style || '')}, ${Q(color || '')}, 144, ${reqIn});`);
}
function mkRemnant(id, num, wh, style, color, lenIn, retId, itemId) {
  superSql(`INSERT INTO public.returned_remnants (id, remnant_number, return_id, return_item_id, warehouse_id, material_type, style, color, width_in, length_in, status)
    VALUES (${Q(id)}, ${Q(num)}, ${Q(retId)}, ${Q(itemId)}, ${Q(wh)}, 'CARPET', ${Q(style || '')}, ${Q(color || '')}, 144, ${lenIn}, 'AVAILABLE');`);
}
function mkReturn(id, num, wh) {
  superSql(`INSERT INTO public.returns (id, return_number, warehouse_id, reason, status) VALUES (${Q(id)}, ${Q(num)}, ${Q(wh)}, 'EXCESS_MATERIAL', 'READY_FOR_DISPOSITION');`);
}
function mkReturnItem(id, retId, wh, cond, qty) {
  superSql(`INSERT INTO public.return_items (id, return_id, warehouse_id, material_type, condition, returned_quantity, measured_in, status)
    VALUES (${Q(id)}, ${Q(retId)}, ${Q(wh)}, 'CARPET', ${Q(cond)}, ${qty}, ${qty}, 'INSPECTED');`);
}
function mkOrder(id, wh, num) {
  superSql(`INSERT INTO public.orders (id, number, warehouse_id, property, status) VALUES (${Q(id)}, ${Q(num)}, ${Q(wh)}, 'Test Property', 'DRAFT');`);
}
function mkOrderItem(id, orderId, style, color) {
  superSql(`INSERT INTO public.order_items (id, order_id, seq, style, color, material_type, uom, quantity_in)
    VALUES (${Q(id)}, ${Q(orderId)}, 1, ${Q(style)}, ${Q(color)}, 'CARPET', 'LF', 100);`);
}
function rollBalance(id) { return parseInt(superSql(`SELECT expected_in FROM public.rolls WHERE id=${Q(id)};`), 10); }
function rollVersion(id) { return parseInt(superSql(`SELECT version FROM public.rolls WHERE id=${Q(id)};`), 10); }
function countRows(table, where) { return parseInt(superSql(`SELECT count(*) FROM public.${table} WHERE ${where};`), 10); }

// ---------- run ----------
rebuild();

console.log('\n[1] migration chain, schema version, least privilege');
t('schema_version_history max = 15', () => {
  assertEq(superSql('SELECT max(version) FROM public.schema_version_history;'), '15');
});
t('anon cannot execute sensitive RPCs (0015)', () => {
  for (const fn of ['record_cut', 'reserve_inventory', 'reserve_remnant', 'return_restock', 'create_receipt', 'submit_sales_order']) {
    const r = superSql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='${fn}' AND has_function_privilege('anon', p.oid, 'execute');`);
    assertEq(r, '0', 'anon execute on ' + fn);
  }
});
t('authenticated can execute sensitive RPCs', () => {
  const r = superSql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='record_cut' AND has_function_privilege('authenticated', p.oid, 'execute');`);
  assertEq(r, '1');
});
t('no function grants EXECUTE to PUBLIC (0015 revoke)', () => {
  const r = superSql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f'
    AND has_function_privilege('public', p.oid, 'execute');`);
  assertEq(r, '0', 'functions with PUBLIC execute');
});
t('migration 0015 documents the PUBLIC-default limitation + revoke pattern', () => {
  const src = require('fs').readFileSync(ROOT + '/supabase/migrations/0015_function_least_privilege.sql', 'utf8');
  assert(/CANNOT be removed/i.test(src), '0015 documents the limitation');
  assert(/REVOKE EXECUTE ON FUNCTION/i.test(src), '0015 mandates explicit revoke in future migrations');
});

console.log('\n[2] server-side remnant compatibility (0010)');
(function () {
  const wo = nid('WO'), line = nid('WL'), rem = nid('REM');
  mkWO(wo, 'WHA', 'WO-COMPAT'); mkLine(line, wo, 'Shaw Floors', 'Harbor Gray', 60);
  mkReturn('R-COMPAT', 'RET-COMPAT', 'WHA'); mkReturnItem('RI-COMPAT', 'R-COMPAT', 'WHA', 'CUT_REMNANT', 80);
  mkRemnant(rem, 'REM-COMPAT', 'WHA', 'Shaw Floors', 'Harbor Gray', 80, 'R-COMPAT', 'RI-COMPAT');

  t('employee reserves compatible remnant (material match)', () => {
    const r = rpc(EMP_A, `reserve_remnant(${Q(wo)}, ${Q(line)}, ${Q(rem)}, 60, 'Eddie', 'WHA', '205B', ${Q(nid('CR'))}, NULL, NULL)`);
    assertEq(r.ok, true, JSON.stringify(r));
  });
  t('employee mismatch without override is denied', () => {
    const rem2 = nid('REM'), line2 = nid('WL');
    mkLine(line2, wo, 'Mohawk', 'Ocean Blue', 60);
    mkRemnant(rem2, 'REM-C2', 'WHA', 'Shaw Floors', 'Harbor Gray', 80, 'R-COMPAT', 'RI-COMPAT');
    const code = rpcDenyCode(EMP_A, `reserve_remnant(${Q(wo)}, ${Q(line2)}, ${Q(rem2)}, 60, 'Eddie', 'WHA', '205B', ${Q(nid('CR'))}, NULL, NULL)`);
    assertEq(code, 'COMPATIBILITY_OVERRIDE_DENIED', 'got ' + code);
  });
  t('supervisor mismatch without reason is denied', () => {
    const rem3 = nid('REM'), line3 = nid('WL');
    mkLine(line3, wo, 'Beaulieu', 'Sand', 60);
    mkRemnant(rem3, 'REM-C3', 'WHA', 'Shaw Floors', 'Harbor Gray', 80, 'R-COMPAT', 'RI-COMPAT');
    const code = rpcDenyCode(SUP_A, `reserve_remnant(${Q(wo)}, ${Q(line3)}, ${Q(rem3)}, 60, 'Sam', 'WHA', '205B', ${Q(nid('CR'))}, 'Sam', NULL)`);
    assertEq(code, 'COMPATIBILITY_MISMATCH', 'got ' + code);
  });
  t('supervisor mismatch with reason succeeds + override row recorded', () => {
    const rem4 = nid('REM'), line4 = nid('WL'), key = nid('CR');
    mkLine(line4, wo, 'Dixie', 'Clay', 60);
    mkRemnant(rem4, 'REM-C4', 'WHA', 'Shaw Floors', 'Harbor Gray', 80, 'R-COMPAT', 'RI-COMPAT');
    const r = rpc(SUP_A, `reserve_remnant(${Q(wo)}, ${Q(line4)}, ${Q(rem4)}, 60, 'Sam', 'WHA', '205B', ${Q(key)}, 'Sam', 'Customer accepted substitute per ticket 4417')`);
    assertEq(r.ok, true, JSON.stringify(r));
    const row = superSql(`SELECT created_by_name, reason, work_order_id, line_id, remnant_id, expected_material, actual_material, created_at IS NOT NULL AS has_ts
      FROM public.remnant_compatibility_overrides WHERE work_order_id=${Q(wo)} AND line_id=${Q(line4)} AND remnant_id=${Q(rem4)};`);
    assert(row.includes('Sam'), 'override user recorded: ' + row);
    assert(row.includes('Customer accepted substitute per ticket 4417'), 'reason recorded: ' + row);
    assert(row.includes(wo) && row.includes(line4) && row.includes(rem4), 'WO/line/remnant recorded: ' + row);
    assert(row.includes('Dixie') && row.includes('Shaw Floors'), 'expected/actual material recorded: ' + row);
    assert(row.endsWith('|t'), 'timestamp recorded: ' + row);
  });
  t('blank override reason is rejected', () => {
    const rem5 = nid('REM'), line5 = nid('WL');
    mkLine(line5, wo, 'Tarkett', 'Stone', 60);
    mkRemnant(rem5, 'REM-C5', 'WHA', 'Shaw Floors', 'Harbor Gray', 80, 'R-COMPAT', 'RI-COMPAT');
    const code = rpcDenyCode(SUP_A, `reserve_remnant(${Q(wo)}, ${Q(line5)}, ${Q(rem5)}, 60, 'Sam', 'WHA', '205B', ${Q(nid('CR'))}, 'Sam', '   ')`);
    assertEq(code, 'COMPATIBILITY_MISMATCH', 'got ' + code);
  });
  t('audit event MATERIAL_COMPATIBILITY_OVERRIDE exists', () => {
    const n = countRows('audit_events', `action='MATERIAL_COMPATIBILITY_OVERRIDE'`);
    assert(n >= 1, 'expected >=1 override audit event, got ' + n);
  });
})();

console.log('\n[3] authorization hardening (0011) + cut consumption (0013)');
(function () {
  const wo = nid('WO'), line = nid('WL'), roll = nid('ROLL');
  mkWO(wo, 'WHA', 'WO-AUTHZ'); mkLine(line, wo, 'Shaw Floors', 'Harbor Gray', 60);
  mkRoll(roll, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');

  t('employee cannot pass free-text mismatch approval', () => {
    const code = rpcDenyCode(EMP_A, `reserve_inventory(${Q(wo)}, ${Q(line)}, ${Q(roll)}, 60, 'Eddie', 'WHA', '205B', ${Q(nid('CR'))}, NULL, 'Some Boss', NULL)`);
    assertEq(code, 'APPROVAL_DENIED', 'got ' + code);
  });
  t('employee cannot pass free-text over-approval', () => {
    const code = rpcDenyCode(EMP_A, `reserve_inventory(${Q(wo)}, ${Q(line)}, ${Q(roll)}, 60, 'Eddie', 'WHA', '205B', ${Q(nid('CR'))}, NULL, NULL, 'Some Boss')`);
    assertEq(code, 'APPROVAL_DENIED', 'got ' + code);
  });
  t('supervisor approval path still works', () => {
    const r = rpc(SUP_A, `reserve_inventory(${Q(wo)}, ${Q(line)}, ${Q(roll)}, 60, 'Sam', 'WHA', '205B', ${Q(nid('CR'))}, NULL, 'Sam', NULL)`);
    assertEq(r.ok, true, JSON.stringify(r));
  });
  t('employee ordinary reservation (no approval) works', () => {
    const r = rpc(EMP_A, `reserve_inventory(${Q(wo)}, ${Q(line)}, ${Q(roll)}, 60, 'Eddie', 'WHA', '205B', ${Q(nid('CR'))}, NULL, NULL, NULL)`);
    assertEq(r.ok, true, JSON.stringify(r));
  });
  t('employee direct RESERVED->RELEASED is denied', () => {
    const a = superSql(`SELECT id FROM public.inventory_assignments WHERE work_order_id=${Q(wo)} AND status='RESERVED' LIMIT 1;`);
    let denied = false;
    try { userSql(EMP_A, `UPDATE public.inventory_assignments SET status='RELEASED' WHERE id=${Q(a)};`); }
    catch (e) { denied = /denied|FORBIDDEN|Supervisor|permission/i.test(e.message); }
    assert(denied, 'expected employee direct release to be denied');
  });
  t('supervisor direct RESERVED->RELEASED succeeds', () => {
    const a = superSql(`SELECT id FROM public.inventory_assignments WHERE work_order_id=${Q(wo)} AND status='RESERVED' LIMIT 1;`);
    assert(a, 'need a RESERVED assignment');
    userSql(SUP_A, `UPDATE public.inventory_assignments SET status='RELEASED' WHERE id=${Q(a)};`);
    const st = superSql(`SELECT status FROM public.inventory_assignments WHERE id=${Q(a)};`);
    assertEq(st, 'RELEASED');
  });
  t('employee record_cut consumes assignment + balance (0013 flag)', () => {
    const roll2 = nid('ROLL'), wo2 = nid('WO'), line2 = nid('WL');
    mkRoll(roll2, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    mkWO(wo2, 'WHA', 'WO-CUT'); mkLine(line2, wo2, 'Shaw Floors', 'Harbor Gray', 60);
    const res = rpc(EMP_A, `reserve_inventory(${Q(wo2)}, ${Q(line2)}, ${Q(roll2)}, 60, 'Eddie', 'WHA', '205B', ${Q(nid('CR'))}, NULL, NULL, NULL)`);
    assertEq(res.ok, true);
    const aid = superSql(`SELECT id FROM public.inventory_assignments WHERE client_request_id=${Q(res.assignment_id || '')} OR work_order_id=${Q(wo2)} ORDER BY created_at DESC LIMIT 1;`);
    const cut = rpc(EMP_A, `record_cut(${Q(roll2)}, 'WO-CUT', 60, 'Eddie', '205B', 'WHA', ${Q(aid)}, ${Q(nid('CR'))}, NULL)`);
    assertEq(cut.ok, true, JSON.stringify(cut));
    assertEq(superSql(`SELECT status FROM public.inventory_assignments WHERE id=${Q(aid)};`), 'CONSUMED');
    assertEq(rollBalance(roll2), 440);
  });
})();

console.log('\n[4] four-role RPC matrix');
(function () {
  // Each entry: [rpcName, buildCall(role, fx) -> call string, expectAllowed per role]
  // fx holds fresh fixtures per RPC so role attempts never collide.
  function matrix(name, setup, callFor, allowed) {
    const roles = { EMP_A, SUP_A, MGR_A, ADM_A };
    const names = { EMP_A: 'EMP', SUP_A: 'SUP', MGR_A: 'MGR', ADM_A: 'ADM' };
    t(name, () => {
      for (const rk of Object.keys(roles)) {
        const fx = setup(rk);
        const code = rpcDenyCode(roles[rk], callFor(rk, fx));
        const ok = code === 'ALLOWED';
        assertEq(ok, allowed[rk], `${names[rk]}: expected ${allowed[rk] ? 'ALLOW' : 'DENY'}, got ${ok ? 'ALLOW' : code}`);
      }
    });
  }
  const ALL = { EMP_A: true, SUP_A: true, MGR_A: true, ADM_A: true };
  const SUPUP = { EMP_A: false, SUP_A: true, MGR_A: true, ADM_A: true };

  matrix('record_cut: all roles', () => {
    const r = nid('ROLL'); mkRoll(r, 'WHA', 400, 'Shaw Floors', 'Harbor Gray'); return { r };
  }, (rk, fx) => `record_cut(${Q(fx.r)}, 'WO-1', 10, 'X', '205B', 'WHA', NULL, ${Q(nid('CR'))}, NULL)`, ALL);

  matrix('reserve_inventory plain: all roles', () => {
    const wo = nid('WO'), li = nid('WL'), r = nid('ROLL');
    mkWO(wo, 'WHA', 'WO-' + seq); mkLine(li, wo, 'Shaw Floors', 'Harbor Gray', 60); mkRoll(r, 'WHA', 400, 'Shaw Floors', 'Harbor Gray');
    return { wo, li, r };
  }, (rk, fx) => `reserve_inventory(${Q(fx.wo)}, ${Q(fx.li)}, ${Q(fx.r)}, 60, 'X', 'WHA', '205B', ${Q(nid('CR'))}, NULL, NULL, NULL)`, ALL);

  matrix('reserve_inventory with approval: supervisor+', () => {
    const wo = nid('WO'), li = nid('WL'), r = nid('ROLL');
    mkWO(wo, 'WHA', 'WO-' + seq); mkLine(li, wo, 'Shaw Floors', 'Harbor Gray', 60); mkRoll(r, 'WHA', 400, 'Shaw Floors', 'Harbor Gray');
    return { wo, li, r };
  }, (rk, fx) => `reserve_inventory(${Q(fx.wo)}, ${Q(fx.li)}, ${Q(fx.r)}, 60, 'X', 'WHA', '205B', ${Q(nid('CR'))}, NULL, 'Boss', NULL)`, SUPUP);

  matrix('record_cycle_count: all roles', () => {
    const r = nid('ROLL'); mkRoll(r, 'WHA', 400, 'Shaw Floors', 'Harbor Gray');
    const s = nid('SES'); mkSession(s, 'WHA'); return { r, s };
  }, (rk, fx) => `record_cycle_count(${Q(fx.r)}, 'WHA', '205B', 400, 398, 'SHORT', 'X', ${Q(fx.s)}, 'matrix')`, ALL);

  matrix('create_order: all roles', () => ({ k: nid('ORD') }),
    (rk, fx) => `create_order(${Q(fx.k)}, 'WHA', 'Prop', 'Acct', NULL, NULL, 'NORMAL', 'X', NULL, NULL)`, ALL);

  matrix('submit_sales_order: supervisor+', () => {
    const o = nid('ORD'); mkOrder(o, 'WHA', 'SO-' + seq); mkOrderItem(nid('OI'), o, 'Shaw Floors', 'Harbor Gray');
    return { o };
  }, (rk, fx) => `submit_sales_order(${Q(fx.o)}, ${Q(nid('SOX'))}, ${Q('SO-' + seq)}, 'X')`, SUPUP);

  matrix('release_sales_order_line: supervisor+', () => {
    const o = nid('ORD'); mkOrder(o, 'WHA', 'REL-' + seq); mkOrderItem(nid('OI'), o, 'Shaw Floors', 'Harbor Gray');
    const so = rpc(MGR_A, `submit_sales_order(${Q(o)}, ${Q(nid('SOX'))}, 'SOREL-${seq}', 'Mia')`);
    assertEq(so.ok, true, JSON.stringify(so));
    const line = superSql(`SELECT id FROM public.sales_order_lines WHERE sales_order_id=${Q(so.sales_order_id)} LIMIT 1;`);
    return { line };
  }, (rk, fx) => `release_sales_order_line(${Q(fx.line)}, ${Q(nid('WO'))}, 'WO-${seq}', 'Shaw Floors', 'Harbor Gray', 'CARPET', 'LF', 144, 60, 1, 'X')`, SUPUP);

  matrix('receive_roll: all roles (override needs supervisor+)', () => {
    const rc = nid('RCV');
    superSql(`INSERT INTO public.receipts (id, number, warehouse_id, status, created_by, client_request_key) VALUES (${Q(rc)}, 'RCV-${seq}', 'WHA', 'RECEIVING', 'Mia', ${Q(nid('RK'))});`);
    return { rc };
  }, (rk, fx) => `receive_roll(${Q(fx.rc)}, ${Q(nid('RL'))}, ${Q(nid('RK'))}, 'BC-${seq}', ${Q(nid('ROLL'))}, 'Shaw', 'Gray', 'Shaw', 144, 300, '205B', 'X', false)`, ALL);

  t('receive_roll duplicate-barcode override: supervisor+', () => {
    const rc = nid('RCV');
    superSql(`INSERT INTO public.receipts (id, number, warehouse_id, status, created_by, client_request_key) VALUES (${Q(rc)}, 'RCV-DUP-${seq}', 'WHA', 'RECEIVING', 'Mia', ${Q(nid('RK'))});`);
    const existing = nid('ROLL'); mkRoll(existing, 'WHA', 400, 'Shaw', 'Gray');
    const bc = 'BC-' + existing; // duplicate barcode
    const empCode = rpcDenyCode(EMP_A, `receive_roll(${Q(rc)}, ${Q(nid('RL'))}, ${Q(nid('RK'))}, ${Q(bc)}, ${Q(nid('ROLL'))}, 'Shaw', 'Gray', 'Shaw', 144, 300, '205B', 'Eddie', true)`);
    assert(/FORBIDDEN|RAISED/.test(empCode), 'employee duplicate override denied, got ' + empCode);
    const sup = rpc(SUP_A, `receive_roll(${Q(rc)}, ${Q(nid('RL'))}, ${Q(nid('RK'))}, ${Q(bc)}, ${Q(nid('ROLL'))}, 'Shaw', 'Gray', 'Shaw', 144, 300, '205B', 'Sam', true)`);
    assertEq(sup.ok, true, JSON.stringify(sup));
  });

  matrix('return_restock: supervisor+', () => {
    const ret = nid('RET'), it = nid('RI'), r = nid('ROLL');
    mkReturn(ret, 'RET-' + seq, 'WHA'); mkReturnItem(it, ret, 'WHA', 'GOOD', 50); mkRoll(r, 'WHA', 400, 'Shaw Floors', 'Harbor Gray');
    return { it, r };
  }, (rk, fx) => `return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'X', 'Boss', ${Q(nid('RK'))})`, SUPUP);

  matrix('reserve_remnant compatible: all roles', () => {
    const wo = nid('WO'), li = nid('WL'), rem = nid('REM');
    mkWO(wo, 'WHA', 'WOR-' + seq); mkLine(li, wo, 'Shaw Floors', 'Harbor Gray', 60);
    mkReturn('R-' + seq, 'RET-' + seq, 'WHA'); mkReturnItem('RI-' + seq, 'R-' + seq, 'WHA', 'CUT_REMNANT', 80);
    mkRemnant(rem, 'REM-' + seq, 'WHA', 'Shaw Floors', 'Harbor Gray', 80, 'R-' + seq, 'RI-' + seq);
    return { wo, li, rem };
  }, (rk, fx) => `reserve_remnant(${Q(fx.wo)}, ${Q(fx.li)}, ${Q(fx.rem)}, 60, 'X', 'WHA', '205B', ${Q(nid('CR'))}, NULL, NULL)`, ALL);

  matrix('reserve_remnant override: supervisor+', () => {
    const wo = nid('WO'), li = nid('WL'), rem = nid('REM');
    mkWO(wo, 'WHA', 'WOO-' + seq); mkLine(li, wo, 'Mohawk', 'Ocean Blue', 60);
    mkReturn('RR-' + seq, 'RETM-' + seq, 'WHA'); mkReturnItem('RIM-' + seq, 'RR-' + seq, 'WHA', 'CUT_REMNANT', 80);
    mkRemnant(rem, 'REMM-' + seq, 'WHA', 'Shaw Floors', 'Harbor Gray', 80, 'RR-' + seq, 'RIM-' + seq);
    return { wo, li, rem };
  }, (rk, fx) => `reserve_remnant(${Q(fx.wo)}, ${Q(fx.li)}, ${Q(fx.rem)}, 60, 'X', 'WHA', '205B', ${Q(nid('CR'))}, 'Boss', 'customer accepted')`, SUPUP);
})();

console.log('\n[5] functional matrix');
(function () {
  t('cut reduces balance + bumps version; over-cut rejected', () => {
    const r = nid('ROLL'); mkRoll(r, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    const c1 = rpc(EMP_A, `record_cut(${Q(r)}, 'WO-1', 120, 'Eddie', '205B', 'WHA', NULL, ${Q(nid('CR'))}, NULL)`);
    assertEq(c1.ok, true, JSON.stringify(c1));
    assertEq(rollBalance(r), 380); assertEq(rollVersion(r), 2);
    const c2 = rpc(EMP_A, `record_cut(${Q(r)}, 'WO-1', 999, 'Eddie', '205B', 'WHA', NULL, ${Q(nid('CR'))}, NULL)`);
    assertEq(c2.ok, false); assertEq(c2.error.code, 'INSUFFICIENT_BALANCE');
  });
  t('stale expected_version -> ROLL_VERSION_CONFLICT', () => {
    const r = nid('ROLL'); mkRoll(r, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    const c = rpc(EMP_A, `record_cut(${Q(r)}, 'WO-1', 50, 'Eddie', '205B', 'WHA', NULL, ${Q(nid('CR'))}, 99)`);
    assertEq(c.ok, false); assertEq(c.error.code, 'ROLL_VERSION_CONFLICT');
  });
  t('cut idempotency: same client_request_id cuts once', () => {
    const r = nid('ROLL'); mkRoll(r, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    const key = nid('CR');
    const c1 = rpc(EMP_A, `record_cut(${Q(r)}, 'WO-1', 40, 'Eddie', '205B', 'WHA', NULL, ${Q(key)}, NULL)`);
    const c2 = rpc(EMP_A, `record_cut(${Q(r)}, 'WO-1', 40, 'Eddie', '205B', 'WHA', NULL, ${Q(key)}, NULL)`);
    assertEq(c1.ok, true); assertEq(c2.ok, true); assertEq(c2.duplicate, true);
    assertEq(countRows('cut_transactions', `roll_id=${Q(r)}`), 1);
    assertEq(rollBalance(r), 460);
  });
  t('reservation lifecycle: RESERVED -> CONSUMED via cut (supervisor path)', () => {
    const wo = nid('WO'), li = nid('WL'), r = nid('ROLL');
    mkWO(wo, 'WHA', 'WO-LIFE'); mkLine(li, wo, 'Shaw Floors', 'Harbor Gray', 60); mkRoll(r, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    const res = rpc(SUP_A, `reserve_inventory(${Q(wo)}, ${Q(li)}, ${Q(r)}, 60, 'Sam', 'WHA', '205B', ${Q(nid('CR'))}, NULL, NULL, NULL)`);
    assertEq(res.ok, true);
    const aid = res.assignment_id;
    const cut = rpc(SUP_A, `record_cut(${Q(r)}, 'WO-LIFE', 60, 'Sam', '205B', 'WHA', ${Q(aid)}, ${Q(nid('CR'))}, NULL)`);
    assertEq(cut.ok, true, JSON.stringify(cut));
    assertEq(superSql(`SELECT status FROM public.inventory_assignments WHERE id=${Q(aid)};`), 'CONSUMED');
    assertEq(rollBalance(r), 440);
  });
  t('direct RESERVED -> RELEASED requires supervisor+', () => {
    const wo = nid('WO'), li = nid('WL'), r = nid('ROLL');
    mkWO(wo, 'WHA', 'WO-REL'); mkLine(li, wo, 'Shaw Floors', 'Harbor Gray', 60); mkRoll(r, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    const res = rpc(SUP_A, `reserve_inventory(${Q(wo)}, ${Q(li)}, ${Q(r)}, 60, 'Sam', 'WHA', '205B', ${Q(nid('CR'))}, NULL, NULL, NULL)`);
    const aid = res.assignment_id;
    let empDenied = false;
    try { userSql(EMP_A, `UPDATE public.inventory_assignments SET status='RELEASED' WHERE id=${Q(aid)};`); }
    catch (e) { empDenied = /Supervisor or above/.test(e.message); }
    assert(empDenied, 'employee direct release denied');
    userSql(SUP_A, `UPDATE public.inventory_assignments SET status='RELEASED' WHERE id=${Q(aid)};`);
    assertEq(superSql(`SELECT status FROM public.inventory_assignments WHERE id=${Q(aid)};`), 'RELEASED');
  });
  t('cycle count records without moving trusted balance or bumping version', () => {
    const r = nid('ROLL'); mkRoll(r, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    const s = nid('SES'); mkSession(s, 'WHA');
    const c = rpc(EMP_A, `record_cycle_count(${Q(r)}, 'WHA', '205B', 500, 493, 'SHORT', 'Eddie', ${Q(s)}, 'functional')`);
    assertEq(c.ok, true, JSON.stringify(c));
    assertEq(rollBalance(r), 500); assertEq(rollVersion(r), 1);
    assertEq(countRows('cycle_count_records', `roll_id=${Q(r)}`), 1);
  });
  t('order -> submit -> SO -> release line -> WO', () => {
    const o = nid('ORD'); mkOrder(o, 'WHA', 'FLOW-' + seq); mkOrderItem(nid('OI'), o, 'Shaw Floors', 'Harbor Gray');
    const so = rpc(SUP_A, `submit_sales_order(${Q(o)}, ${Q(nid('SOX'))}, 'SOFLOW-${seq}', 'Sam')`);
    assertEq(so.ok, true, JSON.stringify(so));
    assertEq(superSql(`SELECT status FROM public.orders WHERE id=${Q(o)};`), 'SUBMITTED');
    const line = superSql(`SELECT id FROM public.sales_order_lines WHERE sales_order_id=${Q(so.sales_order_id)} LIMIT 1;`);
    const rel = rpc(SUP_A, `release_sales_order_line(${Q(line)}, ${Q(nid('WO'))}, 'WOFLOW-${seq}', 'Shaw Floors', 'Harbor Gray', 'CARPET', 'LF', 144, 60, 1, 'Sam')`);
    assertEq(rel.ok, true, JSON.stringify(rel));
    assertEq(countRows('work_orders', `sales_order_line_id=${Q(line)}`), 1);
  });
  t('loadout create -> complete (supervisor)', () => {
    const wo = nid('WO'); mkWO(wo, 'WHA', 'WO-LO-' + seq);
    const lo = rpc(SUP_A, `start_loadout(${Q(nid('LO'))}, ${Q(nid('RK'))}, ${Q(wo)}, 'Sam', '[]')`);
    assertEq(lo.ok, true, JSON.stringify(lo));
    const done = rpc(SUP_A, `complete_loadout(${Q(lo.loadout_id)}, 'Sam')`);
    assertEq(done.ok, true, JSON.stringify(done));
    assertEq(superSql(`SELECT status FROM public.loadouts WHERE id=${Q(lo.loadout_id)};`), 'COMPLETED');
  });
  t('receipt create -> receive_roll creates roll (supervisor)', () => {
    const rc = rpc(SUP_A, `create_receipt(${Q(nid('RCV'))}, ${Q(nid('RK'))}, 'Shaw Direct', 'PO-77', false, 'pilot', 'Sam')`);
    assertEq(rc.ok, true, JSON.stringify(rc));
    const rollId = nid('ROLL');
    const rr = rpc(SUP_A, `receive_roll(${Q(rc.receipt_id)}, ${Q(nid('RL'))}, ${Q(nid('RK'))}, 'BC-NEW-1', ${Q(rollId)}, 'Shaw', 'Gray', 'Shaw', 144, 300, '205B', 'Sam', false)`);
    assertEq(rr.ok, true, JSON.stringify(rr));
    assertEq(rollBalance(rollId), 300);
  });
  t('return loop -> restock raises trusted balance once (supervisor+)', () => {
    const ret = nid('RET'), it = nid('RI'), r = nid('ROLL');
    mkReturn(ret, 'RETF-' + seq, 'WHA'); mkReturnItem(it, ret, 'WHA', 'GOOD', 50); mkRoll(r, 'WHA', 400, 'Shaw Floors', 'Harbor Gray');
    const rs = rpc(MGR_A, `return_restock(${Q(it)}, ${Q(r)}, NULL, '205B', 'Mia', 'Mia', ${Q(nid('RK'))})`);
    assertEq(rs.ok, true, JSON.stringify(rs));
    assertEq(rollBalance(r), 450);
    assertEq(superSql(`SELECT disposition FROM public.return_dispositions WHERE return_item_id=${Q(it)} ORDER BY created_at DESC LIMIT 1;`), 'RESTOCK');
    assertEq(superSql(`SELECT status FROM public.return_items WHERE id=${Q(it)};`), 'DISPOSITION_COMPLETE');
  });
  t('employee can read own-warehouse work orders, not create via RPC without auth', () => {
    const wo = nid('WO'); mkWO(wo, 'WHA', 'WO-READ');
    const n = scalar(EMP_A, `SELECT count(*) FROM public.work_orders WHERE id=${Q(wo)};`);
    assertEq(n, '1');
  });
})();

console.log('\n[6] return_restock atomicity matrix');
(function () {
  function restockFx(cond, retStatus, itemStatus) {
    const ret = nid('RET'), it = nid('RI'), r = nid('ROLL');
    superSql(`INSERT INTO public.returns (id, return_number, warehouse_id, reason, status) VALUES (${Q(ret)}, 'RETK-${seq}', 'WHA', 'EXCESS_MATERIAL', ${Q(retStatus || 'READY_FOR_DISPOSITION')});`);
    superSql(`INSERT INTO public.return_items (id, return_id, warehouse_id, material_type, condition, returned_quantity, measured_in, status)
      VALUES (${Q(it)}, ${Q(ret)}, 'WHA', 'CARPET', ${cond === null ? 'NULL' : Q(cond)}, 50, 50, ${Q(itemStatus || 'INSPECTED')});`);
    mkRoll(r, 'WHA', 400, 'Shaw Floors', 'Harbor Gray');
    return { it, r, before: 400 };
  }
  t('valid restock: balance +qty exactly once, disposition RESTOCK', () => {
    const fx = restockFx('GOOD');
    const r = rpc(MGR_A, `return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'Mia', 'Mia', ${Q(nid('RK'))})`);
    assertEq(r.ok, true, JSON.stringify(r));
    assertEq(rollBalance(fx.r), 450);
    assertEq(superSql(`SELECT disposition FROM public.return_dispositions WHERE return_item_id=${Q(fx.it)} ORDER BY created_at DESC LIMIT 1;`), 'RESTOCK');
  });
  t('duplicate request_key: second call is duplicate, balance unchanged', () => {
    const fx = restockFx('GOOD'); const key = nid('RK');
    const r1 = rpc(MGR_A, `return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'Mia', 'Mia', ${Q(key)})`);
    const r2 = rpc(MGR_A, `return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'Mia', 'Mia', ${Q(key)})`);
    assertEq(r1.ok, true); assertEq(r2.ok, true); assertEq(r2.duplicate, true);
    assertEq(rollBalance(fx.r), 450);
    assertEq(countRows('return_dispositions', `return_item_id=${Q(fx.it)}`), 1);
  });
  t('stale roll version -> ROLL_VERSION_CONFLICT', () => {
    const fx = restockFx('GOOD');
    const r = rpc(MGR_A, `return_restock(${Q(fx.it)}, ${Q(fx.r)}, 999, '205B', 'Mia', 'Mia', ${Q(nid('RK'))})`);
    assertEq(r.ok, false); assertEq(r.error.code, 'ROLL_VERSION_CONFLICT');
    assertEq(rollBalance(fx.r), 400);
  });
  t('employee restock -> denied (supervisor+)', () => {
    const fx = restockFx('GOOD');
    const code = rpcDenyCode(EMP_A, `return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'Eddie', 'Eddie', ${Q(nid('RK'))})`);
    assertEq(code, 'NOT_AUTHORIZED', 'got ' + code);
    assertEq(rollBalance(fx.r), 400);
  });
  t('COMPLETED return -> rejected', () => {
    const fx = restockFx('GOOD', 'COMPLETED');
    const r = rpc(MGR_A, `return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'Mia', 'Mia', ${Q(nid('RK'))})`);
    assertEq(r.ok, false, JSON.stringify(r));
    assertEq(rollBalance(fx.r), 400);
  });
  t('already-dispositioned item -> rejected', () => {
    const fx = restockFx('GOOD', 'READY_FOR_DISPOSITION', 'DISPOSITION_COMPLETE');
    const r = rpc(MGR_A, `return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'Mia', 'Mia', ${Q(nid('RK'))})`);
    assertEq(r.ok, false, JSON.stringify(r));
  });
  t('damaged condition -> CONDITION_NOT_RESTOCKABLE', () => {
    const fx = restockFx('DAMAGED');
    const r = rpc(MGR_A, `return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'Mia', 'Mia', ${Q(nid('RK'))})`);
    assertEq(r.ok, false); assertEq(r.error.code, 'CONDITION_NOT_RESTOCKABLE');
  });
  t('null quantity item -> rejected', () => {
    const fx = restockFx('GOOD');
    superSql(`UPDATE public.return_items SET returned_quantity=NULL, measured_in=NULL WHERE id=${Q(fx.it)};`);
    const r = rpc(MGR_A, `return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'Mia', 'Mia', ${Q(nid('RK'))})`);
    assertEq(r.ok, false, JSON.stringify(r));
  });
  t('concurrent restocks, same key: balance +qty exactly once', async () => {
    const fx = restockFx('GOOD'); const key = nid('RK');
    const call = `SELECT public.return_restock(${Q(fx.it)}, ${Q(fx.r)}, NULL, '205B', 'Mia', 'Mia', ${Q(key)});`;
    const [a, b] = await Promise.all([userSqlAsync(MGR_A, call), userSqlAsync(MGR_A, call)]);
    const pa = JSON.parse(a.split('\n').filter(l => l && l !== 'SET').join(''));
    const pb = JSON.parse(b.split('\n').filter(l => l && l !== 'SET').join(''));
    // Honest concurrent semantics: at most one true restock; the loser is
    // either duplicate:true (saw the committed key) or ALREADY_DISPOSITIONED
    // (saw the committed disposition first). Balance must move exactly once.
    const trueRestocks = [pa, pb].filter(r => r.ok && !r.duplicate).length;
    assert(trueRestocks <= 1, 'at most one true restock: ' + JSON.stringify([pa, pb]));
    assertEq(rollBalance(fx.r), 450);
    assertEq(countRows('return_dispositions', `return_item_id=${Q(fx.it)}`), 1);
  });
})();

console.log('\n[7] deterministic concurrency');
(async function () {
  const jobs = [];
  function ct(name, fn) { jobs.push((async () => {
    try { await fn(); pass++; console.log('  ok - ' + name); }
    catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL - ' + name + ' :: ' + e.message); }
  })()); }

  ct('parallel cuts, same expected version: one wins, balance -cut once', async () => {
    const r = nid('ROLL'); mkRoll(r, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    const v = rollVersion(r);
    const mk = k => `SELECT public.record_cut(${Q(r)}, 'WO-1', 100, 'Eddie', '205B', 'WHA', NULL, ${Q(k)}, ${v});`;
    const [a, b] = await Promise.all([userSqlAsync(EMP_A, mk(nid('CR'))), userSqlAsync(EMP_A, mk(nid('CR')))]);
    const pa = JSON.parse(a.split('\n').filter(l => l && l !== 'SET').join(''));
    const pb = JSON.parse(b.split('\n').filter(l => l && l !== 'SET').join(''));
    const wins = [pa, pb].filter(x => x.ok).length;
    const conflicts = [pa, pb].filter(x => !x.ok && x.error && x.error.code === 'ROLL_VERSION_CONFLICT').length;
    assertEq(wins, 1, JSON.stringify([pa, pb])); assertEq(conflicts, 1, JSON.stringify([pa, pb]));
    assertEq(rollBalance(r), 400);
  });

  ct('parallel reserves, same idempotency key: exactly one assignment', async () => {
    const wo = nid('WO'), li = nid('WL'), r = nid('ROLL');
    mkWO(wo, 'WHA', 'WO-' + seq); mkLine(li, wo, 'Shaw Floors', 'Harbor Gray', 60); mkRoll(r, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    const key = nid('CR');
    const mk = () => `SELECT public.reserve_inventory(${Q(wo)}, ${Q(li)}, ${Q(r)}, 60, 'Eddie', 'WHA', '205B', ${Q(key)}, NULL, NULL, NULL);`;
    const [a, b] = await Promise.all([userSqlAsync(EMP_A, mk()), userSqlAsync(EMP_A, mk())]);
    const pa = JSON.parse(a.split('\n').filter(l => l && l !== 'SET').join(''));
    const pb = JSON.parse(b.split('\n').filter(l => l && l !== 'SET').join(''));
    assert(pa.ok && pb.ok);
    assert(pa.duplicate !== pb.duplicate, 'exactly one duplicate');
    assertEq(countRows('inventory_assignments', `client_request_id=${Q(key)}`), 1);
  });

  ct('parallel order submits: exactly one sales order', async () => {
    const o = nid('ORD'); mkOrder(o, 'WHA', 'RACE-' + seq); mkOrderItem(nid('OI'), o, 'Shaw Floors', 'Harbor Gray');
    const mk = k => `SELECT public.submit_sales_order(${Q(o)}, ${Q(k)}, 'SORACE-${seq}', 'Sam');`;
    const [a, b] = await Promise.all([userSqlAsync(SUP_A, mk(nid('SOX'))), userSqlAsync(SUP_A, mk(nid('SOX')))]);
    const pa = JSON.parse(a.split('\n').filter(l => l && l !== 'SET').join(''));
    const pb = JSON.parse(b.split('\n').filter(l => l && l !== 'SET').join(''));
    assert(pa.ok && pb.ok, JSON.stringify([pa, pb]));
    assertEq(countRows('sales_orders', `source_order_id=${Q(o)}`), 1);
  });

  ct('parallel SO line releases: exactly one work order', async () => {
    const o = nid('ORD'); mkOrder(o, 'WHA', 'RACER-' + seq); mkOrderItem(nid('OI'), o, 'Shaw Floors', 'Harbor Gray');
    const so = rpc(MGR_A, `submit_sales_order(${Q(o)}, ${Q(nid('SOX'))}, 'SORACER-${seq}', 'Mia')`);
    assertEq(so.ok, true);
    const line = superSql(`SELECT id FROM public.sales_order_lines WHERE sales_order_id=${Q(so.sales_order_id)} LIMIT 1;`);
    const mk = () => `SELECT public.release_sales_order_line(${Q(line)}, ${Q(nid('WO'))}, 'WORACE-${seq}', 'Shaw Floors', 'Harbor Gray', 'CARPET', 'LF', 144, 60, 1, 'Mia');`;
    const results = await Promise.allSettled([userSqlAsync(MGR_A, mk()), userSqlAsync(MGR_A, mk())]);
    assertEq(countRows('work_orders', `sales_order_line_id=${Q(line)}`), 1, JSON.stringify(results.map(r => r.status)));
  });

  ct('parallel loadout completes: exactly one COMPLETED transition', async () => {
    const wo = nid('WO'); mkWO(wo, 'WHA', 'WO-PLO-' + seq);
    const lo = rpc(SUP_A, `start_loadout(${Q(nid('LO'))}, ${Q(nid('RK'))}, ${Q(wo)}, 'Sam', '[]')`);
    assertEq(lo.ok, true);
    const mk = () => `SELECT public.complete_loadout(${Q(lo.loadout_id)}, 'Sam');`;
    const results = await Promise.allSettled([userSqlAsync(SUP_A, mk()), userSqlAsync(SUP_A, mk())]);
    const oks = results.filter(r => r.status === 'fulfilled' && JSON.parse(r.value.split('\n').filter(l => l && l !== 'SET').join('')).ok).length;
    assert(oks >= 1, 'at least one complete succeeded');
    assertEq(superSql(`SELECT status FROM public.loadouts WHERE id=${Q(lo.loadout_id)};`), 'COMPLETED');
  });

  await Promise.all(jobs);
  await Promise.all(pending);

  console.log('\n[8] two-warehouse RLS isolation');
  (function () {
    const rA = nid('ROLL'); mkRoll(rA, 'WHA', 500, 'Shaw Floors', 'Harbor Gray');
    const woA = nid('WO'); mkWO(woA, 'WHA', 'WO-ISO');
    const retA = nid('RET'); mkReturn(retA, 'RETI-' + seq, 'WHA');
    t('WHB employee sees zero WHA rolls', () => {
      assertEq(scalar(EMP_B, `SELECT count(*) FROM public.rolls WHERE warehouse_id='WHA';`), '0');
    });
    t('WHB employee sees zero WHA work orders', () => {
      assertEq(scalar(EMP_B, `SELECT count(*) FROM public.work_orders WHERE warehouse_id='WHA';`), '0');
    });
    t('WHB employee sees zero WHA returns', () => {
      assertEq(scalar(EMP_B, `SELECT count(*) FROM public.returns WHERE warehouse_id='WHA';`), '0');
    });
    t('WHB employee sees zero WHA audit events', () => {
      assertEq(scalar(EMP_B, `SELECT count(*) FROM public.audit_events WHERE warehouse_id='WHA';`), '0');
    });
    t('WHB employee sees zero WHA cycle count records', () => {
      assertEq(scalar(EMP_B, `SELECT count(*) FROM public.cycle_count_records WHERE warehouse_id='WHA';`), '0');
    });
    t('WHB employee cannot insert a roll into WHA', () => {
      let denied = false;
      try { userSql(EMP_B, `INSERT INTO public.rolls (id, barcode, warehouse_id, expected_in) VALUES ('X-ISO','BCX','WHA',100);`); }
      catch (e) { denied = /policy|denied|violates|permission/i.test(e.message); }
      assert(denied, 'expected RLS denial');
    });
    t('WHB employee cannot update a WHA roll', () => {
      userSql(EMP_B, `UPDATE public.rolls SET location_code='EVIL' WHERE id=${Q(rA)};`);
      assertEq(superSql(`SELECT location_code FROM public.rolls WHERE id=${Q(rA)};`), '205B');
    });
    t('WHB supervisor cannot read WHA documents', () => {
      assertEq(scalar(SUP_B, `SELECT count(*) FROM public.documents WHERE warehouse_id='WHA';`), '0');
    });
    t('WHA employee reads own warehouse rolls (sanity)', () => {
      const n = parseInt(scalar(EMP_A, `SELECT count(*) FROM public.rolls WHERE warehouse_id='WHA';`), 10);
      assert(n >= 1, 'expected >=1, got ' + n);
    });
    t('manager reads cross-warehouse (intended bypass)', () => {
      const n = parseInt(scalar(MGR_A, `SELECT count(*) FROM public.rolls WHERE warehouse_id='WHA';`), 10);
      assert(n >= 1, 'manager should see WHA rolls');
    });
  })();

  console.log('\n[9] private document storage');
  (function () {
    superSql(`INSERT INTO storage.objects (id, bucket_id, name) VALUES (gen_random_uuid(), 'history-cards', 'WHA/ROLL-1/card-1.jpg') ON CONFLICT DO NOTHING;`);
    t('history-cards bucket is private', () => {
      assertEq(superSql(`SELECT public::text FROM storage.buckets WHERE id='history-cards';`), 'false');
    });
    t('WHA employee can read own-warehouse objects', () => {
      const n = parseInt(scalar(EMP_A, `SELECT count(*) FROM storage.objects WHERE bucket_id='history-cards' AND name LIKE 'WHA/%';`), 10);
      assert(n >= 1, 'expected >=1, got ' + n);
    });
    t('WHB employee cannot read WHA objects', () => {
      assertEq(scalar(EMP_B, `SELECT count(*) FROM storage.objects WHERE bucket_id='history-cards' AND name LIKE 'WHA/%';`), '0');
    });
    t('no storage policy grants to anon/public', () => {
      const n = superSql(`SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND (roles::text ILIKE '%anon%' OR roles::text ILIKE '%public%');`);
      assertEq(n, '0', 'storage policies referencing anon/public');
    });
  })();

  console.log(`\nrun9-pg: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log(' - ' + f)); }
  process.exit(fail ? 1 : 0);
})();
