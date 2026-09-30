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

## Run 3 — Assign Inventory (v0.3.0)

Connects work orders to actual warehouse inventory — no second database.

- Assign Inventory module (`#/assign-inventory`, also accepts `?workOrder=XS024536`): tablet-first hub with NEEDS INVENTORY / ASSIGNED / COMPLETED tabs, work-order search (number, property, account, style, color, roll), scan/enter work order, filters (employee, property, material type, date)
- Work order summary + material lines: style, color, material type, UOM, width, required quantity; line status NOT ASSIGNED / PARTIALLY ASSIGNED / ASSIGNED (derived from active reservations — never stored, can't drift)
- Assign roll: existing scanner + roll search; roll card (ID, style, color, width, location, expected + measured balance, MB status, last measurement, last cut); unknown rolls → DISCOVER ROLL via the shared discovered-roll architecture
- Compatibility check: style/color/width/material type → ✓ MATERIAL MATCH / MATERIAL DATA INCOMPLETE / ⚠ MATERIAL MISMATCH (mismatch never assigned silently — supervisor approval required)
- Quantity check: required vs. expected balance → SUFFICIENT / INSUFFICIENT MATERIAL; reserved-across-all-jobs + informational "potential available"
- Reservations: append-only inventory-assignment records (RESERVED / RELEASED / CONSUMED); reserving NEVER changes the trusted roll balance — only cuts do
- Multi-WO on one roll: one roll entity, many assignments; over-reservation guard (total reserved > balance → supervisor confirmation)
- Release: supervisor or assigning employee; record kept as history
- Continue to Cut: assignment flows into the existing cut screen with WO/roll/required prefilled; roll barcode verification required before SAVE CUT (supervisor override for wrong roll); saving the cut consumes the reservation (RESERVED → CONSUMED)
- Audit trail: INVENTORY_ASSIGNED / RELEASED / ROLL_VERIFIED / LOCATION_VERIFIED / OVER_RESERVATION_APPROVED / MATERIAL_MISMATCH_OVERRIDE / ASSIGNMENT_CONSUMED; visible on the work order (Inventory activity) and in the roll ledger (Assigned to Work Order)
- Data: schema v3 (v2 → v3 migration adds assignment collections + material lines); demo orders XS024536 (Ventura Pointe, Marvel/Chrome, 19.75 LF) and XS024537; demo rolls 16628697 (86' 2") and 16628698

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

## Run 4 — Shared Backend + Multi-Device Sync (v0.4.0)

One shared dataset, multiple devices. The app gains a repository layer (`repository.js`) behind a `Repository` facade with two providers:

- **Local Demo** (`DATA_PROVIDER=local`): the existing localStorage behavior, unchanged.
- **Shared Pilot** (`DATA_PROVIDER=shared`): Supabase/PostgreSQL backend via PostgREST + RPC, configured in Settings &rarr; Data mode (Supabase URL + anon key, employee sign-in). No secrets in code; the service-role key never touches the frontend.

PostgreSQL schema in `supabase/migrations/` (16 tables, RLS policies, seed): integer inches everywhere, `rolls.expected_in` as authoritative balance, `rolls.version` for optimistic concurrency, append-only cuts/counts/history/audit, private `history-cards` storage bucket, atomic RPCs `record_cut`, `reserve_inventory`, `record_cycle_count`.

Key behaviors:

- Cuts and reservations go through atomic RPCs — a stale device gets **ROLL UPDATED BY ANOTHER DEVICE** (previous screen balance vs. current backend balance + REFRESH AND CONTINUE) instead of overwriting.
- Offline balance-changing transactions never pretend to succeed: **OFFLINE — CUT NOT SYNCED**, queued for explicit retry with idempotent request IDs.
- Physical measurements stamp measured balance (MB) without moving trusted balances or invalidating other devices' cuts.
- History-card originals live in private storage; confirmed extractions become history events only, never balance changes.
- Local demo data is never auto-uploaded: Settings &rarr; EXPORT LOCAL DATA / IMPORT INTO SHARED BACKEND (explicit, idempotent, existing shared records are never overwritten).

Without a configured Supabase project the app runs in Local Demo mode — the shared code paths are dormant until the owner provides the URL + anon key.

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
