# PILOT DEVICE TEST — FloorGuard Ops v0.9

Run this script on **each** pilot device before the first real shift.
It exercises the scanner, the camera permission states, the phone layout,
and the two-device sync path. Nothing here writes inventory except where
marked — the Scanner Test screen never touches inventory at all.

## A. Scanner Test (nav → 🔬 Scanner Test)

### A1. Camera scan
1. Open Scanner Test. The camera box should show **CAMERA READY**.
2. Point at a real roll barcode. Expected result card:
   - **Raw barcode value**: exactly what the camera read (e.g. `16628697`)
   - **Normalized value**: `01`-prefix stripped, uppercased
   - **Detected type**: ROLL / LOCATION / REMNANT / RETURN / WORK ORDER / UNKNOWN
   - **Timestamp**: when the scan landed
3. Scan a location code (e.g. type `205b` in manual entry): **Location normalization** must show `205b → 205B`.

### A2. Camera permission states (verify each state reads honestly)
- **CAMERA READY** — camera started, preview visible.
- **CAMERA PERMISSION REQUIRED** — deny the browser permission prompt once; the box must say permission is required and offer manual entry (it must NOT spin forever).
- **CAMERA NOT AVAILABLE** — on a device/browser with no camera API or no barcode reader (e.g. desktop Safari without ZXing), the box must say so plainly.
- **USE MANUAL ENTRY** — the manual field is always present and always works, gloves or no gloves.

### A3. Hardware wedge scanner
1. Click the **WEDGE INPUT** field.
2. Scan any barcode with the wedge. The value must land in the field **exactly** as sent (compare against the raw value on the result card).
3. Tap **TEST WEDGE VALUE** — the result card shows raw/normalized/type/timestamp.

### A4. Manual fallback
Type `REM-1001` → detected type must be **REMNANT**. Type `16628697` → **ROLL**. Type `205b` → **LOCATION**, normalized `205B`.

**Pass criteria:** all four input paths produce a result card; no inventory record is created (check History — nothing new).

## B. Phone layout (320 / 360 / 375 / 390 / 430 px)

On each width, open: Dashboard, Count flow, Cut flow, Assign Inventory, Returns, Settings.

- [ ] No horizontal scrolling anywhere (content fits the width).
- [ ] All buttons are tappable (≥44px tall) — especially ASSIGN / CUT / SUBMIT.
- [ ] Action button rows stack vertically instead of squeezing side-by-side.
- [ ] Wide report tables scroll *inside* their card, not the page.
- [ ] The camera box and scan buttons are reachable without zooming.
- [ ] The confirm modal fits on screen with both buttons visible.

Quick method: desktop Chrome DevTools → device toolbar → set each width, or simply test on the smallest real phone on hand (320px is the floor).

## C. Two-device sync test (needs the shared backend from PILOT_BACKEND_SETUP.md)

Device 1 (Dana) and Device 2 (Luis), both signed in, both on SHARED PILOT:

1. Device 1: count roll `16628697` → submit. Device 2: **REFRESH NOW** → the count appears.
2. Device 1: start a cut on the same roll (do NOT confirm). Device 2: cut the same roll and confirm. Device 1: confirm → must show **ROLL UPDATED BY ANOTHER DEVICE**, never a silent double-cut.
3. Device 1: go offline (airplane mode) → attempt a cut → must show **OFFLINE — CUT NOT SYNCED** and queue it in the outbox. Reconnect → open the outbox → **RETRY** → exactly one cut lands.
4. Diagnostics (Manager device): **OPEN PILOT DIAGNOSTICS → RUN CONNECTION TEST** → all green, schema v14+, last-sync time updates after a refresh.

## D. Returns smoke (one full loop on Device 1)

Create → receive → add item → measure → inspect → submit → disposition (restock one line as a supervisor) → verify the roll balance increased by exactly the restocked length and the audit trail shows the restock event.

## Sign-off

| Device | Owner | A | B | C | D | Notes |
|---|---|---|---|---|---|---|
| 1 |  | ☐ | ☐ | ☐ | ☐ |  |
| 2 |  | ☐ | ☐ | ☐ | ☐ |  |
