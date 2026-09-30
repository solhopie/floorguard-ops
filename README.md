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

## Develop

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8080
```

## Test

```
node --check app.js
node tests/run1.test.js
```
