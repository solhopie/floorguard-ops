# FloorGuard Ops

Warehouse operations platform — rebuilt from the ground up.

## Run 1 — Application Foundation + Navigation (v0.1.0)

The foundation. No business workflows yet.

- App shell: sticky topbar with ☰ hamburger, employee chip
- Slide-out navigation drawer (left), grouped: DASHBOARD / WAREHOUSE / OPERATIONS / BUSINESS / SYSTEM
- Hash router (`#/dashboard`, `#/cycle-count`, …); unknown routes fall back to dashboard
- Session: employee sign-in persisted in localStorage; every route except sign-in requires a session; Logout clears it
- Shared components: page headers, cards, dashboard tiles, module placeholders, in-app confirm modal, toast
- Data architecture: one localStorage key (`floorguard_ops_v1`), schema v1, per-module namespaces via `DB.ns('<module-key>')` — later runs plug modules in without touching each other's data
- Dashboard with warehouse + operations module tiles; Settings (switch employee, manage employees, about, reset demo data)

Static site — no build step, no network dependencies. Same proven pattern as the FloorGuard prototype.

## Run 2 — Warehouse Consolidation (v0.2.0)

The legacy standalone prototype's proven warehouse workflows now live here.
FloorGuard Ops is the one app and the one codebase; the prototype is legacy/reference only.

- Cycle Count hub: Free Run / Discovery (any roll, any location), Rapid (location once, loop the scanner), Standard / Verified (expected vs. physical), sessions, discrepancies, review
- Cut / Roll Tracking hub: scan-to-cut with live balance preview, roll ledger (activity + cut history + cycle counts + documents), measured-balance (MB) stamping
- Work Orders: ALL / ASSIGNED / UNASSIGNED, detail, assign employee, link rolls (scan or pick), WO-launched cuts (roll linked, OPEN &rarr; IN_PROGRESS)
- History cards: capture, permanent per-roll records, UNVERIFIED IMPORTED HISTORY extraction (CONFIRM / EDIT / IGNORE)
- Manager report + exports: print/PDF, CSV, structured JSON
- Data: one localStorage key (`floorguard_ops_v1`), schema v2 (warehouse context + roles + shared FloorGuard store), integer-inch measurements, append-only cuts
- Scanner: camera (BarcodeDetector &rarr; vendored ZXing fallback), hardware keyboard wedge, manual entry; `01` manufacturer-prefix stripping; real location codes

## Develop

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8080
```

## Test

```
node --check app.js
node tests/run1.test.js   # 88 assertions: Run 1 foundation
node tests/run2.test.js   # 148 assertions: migrated warehouse workflows
```
