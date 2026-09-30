#!/usr/bin/env python3
"""Extract portable sections from the FloorGuard prototype app.js,
apply mechanical renames (DB.data. -> FG()., route map), and write
a staging file for review before merging into the Ops app.js."""
import re, sys

SRC = '/home/hatch/workspace/floorguard-prototype/app.js'
OUT = '/home/hatch/workspace/floorguard-ops/migrate/port-raw.js'

with open(SRC) as f:
    lines = f.readlines()  # 1-based indexing via lines[i-1]

def rng(a, b):
    return ''.join(lines[a-1:b])

# (start, end) inclusive line ranges to extract, in output order
RANGES = [
    (179, 212),    # rollById, normLoc, rollByBarcode
    (213, 221),    # systemBalance (testBalanceIn legacy field tolerated, UI dropped)
    (226, 229),    # isMeasuredCount
    (230, 260),    # discrepancyRolls
    (262, 310),    # CutService, countsForRoll, recentCountForRoll
    (317, 347),    # fmtLen, fmtDiff, diffCls, fmtWidth, fmtDT, fmtTime, isToday (skip esc)
    (348, 401),    # STATUS, statusChip, computeStatus, buzz/beep/flash/good/bad/warn (skip $)
    (405, 539),    # Scanner
    (541, 556),    # S, lastSavedId, newSession, C/newCutSession, R/newRapid
    (605, 607),    # needRoll/needLoc/needBalance guards
    (677, 732),    # Screens['scan-roll']
    (733, 811),    # mountScannerBox + Screens['scan-loc']
    (812, 874),    # Screens.search, Screens.dup
    (875, 984),    # Screens.balance, confirm, mismatch
    (985, 1187),   # submitCount, cut-scan, cut-entry, cut-saved, saved
    (1188, 1326),  # Screens.roll, importSummary, ledgerHtml
    (1327, 1357),  # Screens.recent, countRow, wireCountRows
    (1358, 1401),  # Screens.count (detail)
    (1476, 1485),  # F, newFreeRun
    (1486, 1586),  # normalizeBarcode, findDiscovered, freeCountsFor, findFreeSession,
                   # fmtDur, freeCountStatus, freeCountDiff, isDiscrepancy, reportRows, sessionMetrics
    (1587, 1604),  # freeSessionBar
    (1605, 1641),  # free-loc (stop before prototype showConfirm at 1642)
    (1663, 1953),  # freeBanner, free-scan, free-balance, saveFreeCount,
                   # endFreeSession, free-summary, sessview, sessions
    (1954, 2035),  # sessionSummaryHtml, mountSessionSummary
    (2036, 2317),  # report helpers, report/export/report-print screens, export fns
    (2318, 2369),  # Screens['disc-roll'] -> rollDiscoveredScreen
    (2370, 2413),  # D, newDocCapture, docsForRoll, findDoc, downscaleImage
    (2414, 2416),  # persistOrThrow -> DB.save()
    (2419, 2580),  # doc-capture, doc-review, doc-view screens, saveDocument
    (2581, 2602),  # extractFromImage, readExtractFields
    (2603, 2694),  # importFieldsHtml, doc-extract screen, docsHtml, wireDocViews
    (2700, 2902),  # rapid-loc, rapidBanner, rapid-scan, rapid-mismatch, rapid-balance
    (2903, 2999),  # prototype supervisor dashboard -> Ops 'reports'
    (3000, 3024),  # Screens.discrepancies
]

# prototype route -> Ops route
ROUTE = {
    'home': 'dashboard', 'employee': 'settings',
    'scan-roll': 'count/standard', 'scan-loc': 'count/standard/loc',
    'dup': 'count/standard/dup', 'balance': 'count/standard/balance',
    'confirm': 'count/standard/confirm', 'mismatch': 'count/standard/mismatch',
    'saved': 'count/standard/saved', 'search': 'rolls/search',
    'roll': 'roll', 'recent': 'history', 'count': 'count/detail',
    'cut-scan': 'cut/scan', 'cut-entry': 'cut/entry', 'cut-saved': 'cut/saved',
    'free-loc': 'count/free/loc', 'free-scan': 'count/free/scan',
    'free-balance': 'count/free/balance', 'free-summary': 'count/free/summary',
    'sessions': 'count/sessions', 'sessview': 'count/session',
    'report': 'count/report', 'export': 'count/export',
    'report-print': 'count/report/print',
    'doc-capture': 'roll/doc', 'doc-review': 'roll/doc/review',
    'doc-view': 'doc', 'doc-extract': 'doc/extract',
    'rapid-loc': 'count/rapid/loc', 'rapid-scan': 'count/rapid/scan',
    'rapid-mismatch': 'count/rapid/mismatch', 'rapid-balance': 'count/rapid/balance',
    'discrepancies': 'count/review', 'dashboard': 'reports', 'disc-roll': 'disc',
}

out = []
out.append('/* ' + '='*70)
out.append('   PORTED FROM FloorGuard prototype (LEGACY / REFERENCE ONLY).')
out.append('   Mechanical extraction; reviewed before merge. DB.data. -> FG().')
out.append('   ' + '='*70 + ' */\n')

for a, b in RANGES:
    chunk = rng(a, b)
    out.append('/* ---- prototype lines %d-%d ---- */' % (a, b))
    out.append(chunk.rstrip() + '\n')

text = '\n'.join(out)

# 1. DB.data. -> FG().
text = text.replace('DB.data.', 'FG().')
# 2. persistOrThrow -> DB.save()
text = re.sub(r'function persistOrThrow\(\) \{\s*\n\s*localStorage\.setItem\(DB\.KEY, JSON\.stringify\(DB\.data\)\);\s*\n\}',
              'function persistOrThrow() { DB.save(); }', text)
# 3. DB.save() stays; DB.reset() in ported dashboard -> reseed floorguard store only
text = text.replace('DB.reset()', 'FGReset()')
# 4. go('x') and go('x', ...) route renames
def go_sub(m):
    q, name = m.group(1), m.group(2)
    return 'go(' + q + ROUTE.get(name, name) + q
text = re.sub(r"go\((['\"])([a-z\-]+)\1", go_sub, text)
# 5. Screens key renames
def scr_sub(m):
    pre, name = m.group(1), m.group(2)
    return pre + ROUTE.get(name, name) + m.group(3)
text = re.sub(r"(Screens\[['\"])([a-z\-]+)(['\"]\] *=)", scr_sub, text)
text = re.sub(r"(Screens\.)(home|dashboard|discrepancies|search|roll|recent|count|saved|balance|confirm|mismatch|dup)( *)= ",
              lambda m: "Screens['" + ROUTE.get(m.group(2), m.group(2)) + "'] = ", text)
# 6. disc-roll -> standalone function used by roll detail fallback
text = text.replace("Screens['disc'] = function (rollId) {", "function rollDiscoveredScreen(rollId) {")
# 7. showConfirm in ported dashboard used native confirm(); keep native (already explicit)
# 8. prototype references to DB.data.currentEmployee handled by rename -> FG().currentEmployee;
#    employees live at DB top level in Ops; fix:
text = text.replace('FG().employees', 'DB.data.employees')
text = text.replace('FG().currentEmployee', 'DB.data.currentEmployee')

with open(OUT, 'w') as f:
    f.write(text)
print('wrote', OUT, len(text), 'chars')

# report anything that still mentions DB.data or unmapped go('x')
for pat in ['DB\\.data', "go\\('testbal", 'testbal']:
    hits = [(i+1, l.rstrip()) for i, l in enumerate(text.split('\n')) if re.search(pat, l)]
    print(pat, '->', len(hits), 'hits')
    for h in hits[:8]: print('   ', h)
