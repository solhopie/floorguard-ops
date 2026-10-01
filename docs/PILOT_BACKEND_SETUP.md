# PILOT BACKEND SETUP — FloorGuard Ops Shared Pilot (v0.9)

This guide sets up the real Supabase backend for the two-device Shared Pilot.
It is the owner's manual work (section 16 of the Run 9 report). Estimated
time: 30–45 minutes. Cost: Supabase free tier is enough for the pilot.

> **Never paste a service-role key into FloorGuard.** The app only ever needs
> the **anon (publishable) key**. The service-role key bypasses every
> database rule in this guide — it lives only in the Supabase dashboard.

## 1. Create the Supabase project

1. Go to https://supabase.com/dashboard and sign in (create a free account if needed).
2. **New project** → name `floorguard-pilot`, set a strong database password (save it in your password manager), pick the region closest to the warehouse.
3. Wait for the project to finish provisioning (~2 minutes).

## 2. Run the migrations (0001–0015)

1. In the Supabase dashboard open **SQL Editor → New query**.
2. In the FloorGuard Ops repo, open `supabase/migrations/` — there are 14 files, `0001_*.sql` through `0014_*.sql`.
3. Run them **in numeric order**, one file per query (paste → **Run**). Each must report success before running the next.
   - 0001–0009: core schema, commercial layer, loadout/receipts, returns.
   - 0010: server-side remnant material-compatibility + override audit.
   - 0011: authorization hardening (approval params, assignment transitions).
   - 0012: authenticated table grants (RLS stays the authorization layer).
   - 0013: legitimate cut consumption for employees.
   - 0014: `schema_version_history` — the app requires schema **v15+** and refuses to run against an older backend ("BACKEND UPDATE REQUIRED").
   - 0015: function least-privilege — revokes the PostgreSQL default PUBLIC execute on all RPCs; only signed-in (`authenticated`) callers can invoke them.
4. Verify: run `select max(version) from public.schema_version_history;` — it must return **15**.

## 3. Seed the pilot data (optional but recommended)

1. Run `supabase/seed.sql` in the SQL Editor the same way.
2. This creates the demo warehouses, rolls, and work orders used in the device test script.

## 4. Verify the private storage bucket

Migration 0004 already creates the `history-cards` bucket as Private. Verify it:

1. Open **Storage** — you should see a bucket named exactly `history-cards`.
2. Confirm it shows as **Private** (not public). History-card photos must never be publicly enumerable.
3. If the bucket is missing (e.g. the migration was skipped), create it manually: **Storage → New bucket**, name `history-cards`, set to **Private**.
4. The bucket policies from the migrations restrict reads/writes to signed-in users of the same warehouse.

## 5. Create pilot users (Auth + linked warehouse rows)

For each pilot device/user:

1. **Authentication → Users → Add user**: enter the employee's email, set a password, **confirm the email manually** (pilot convenience).
2. Copy the new user's **UID**.
3. **SQL Editor** — link the login to a warehouse user row:
   ```sql
   insert into public.users (auth_user_id, warehouse_id, display_name, role, active)
   values ('PASTE-UID-HERE', 'main', 'Marcus', 'MANAGER', true);
   ```
   Roles (use exactly these values): `WAREHOUSE_EMPLOYEE`, `SUPERVISOR`, `MANAGER`, `ADMIN`.
4. Suggested pilot roster:
   - Marcus — MANAGER (approvals, diagnostics)
   - Dana — WAREHOUSE_EMPLOYEE (counts, cuts)
   - Luis — WAREHOUSE_EMPLOYEE (second device)

## 6. Connect each device

On each pilot phone/tablet, open the FloorGuard Ops URL and:

1. **Settings → SHARED PILOT**.
2. **SUPABASE URL**: `https://YOUR-PROJECT-REF.supabase.co` (dashboard → Project Settings → Data API → Project URL).
3. **SUPABASE ANON KEY**: the **anon / publishable** key from the same page (starts with `eyJ…`). This key is public by design; it cannot bypass RLS.
4. **SAVE SETTINGS** — the app immediately runs the backend readiness check:
   - Backend reachable
   - Signed in
   - Schema version (must be v15+)
   - Warehouse membership
   - Document storage
   If any step fails, the exact fix is shown (e.g. "Run migrations up to 14", "Create the history-cards bucket as PRIVATE"). Fix it, then **RUN CONNECTION TEST** again.
5. Sign in with the pilot email + password, then **REFRESH NOW**.

Managers/Admins get an extra **OPEN PILOT DIAGNOSTICS** button in Settings — the same five checks plus schema version and last-sync time, re-runnable any time.

## 7. Verify before the pilot shift

- [ ] `select max(version)` returns 15.
- [ ] `history-cards` bucket exists and is Private.
- [ ] Each pilot user has an Auth login AND a `public.users` row with the right warehouse + role.
- [ ] Both devices pass **Pilot Diagnostics → RUN CONNECTION TEST** (all green).
- [ ] **Scanner Test** (nav → 🔬 Scanner Test) reads a real roll barcode on each device.

## Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| BACKEND UPDATE REQUIRED | Migrations behind → run 0001–0015 in order |
| Not signed in | Sign in with pilot email/password in Settings |
| No warehouse user linked | Insert the `public.users` row (step 5) |
| history-cards 404 | Create the bucket as Private (step 4) |
| ROLL VERSION CONFLICT | Another device updated the roll first → Refresh, then retry |
| OFFLINE — … NOT SYNCED | Device has no network → reconnect; the outbox holds the work until you tap RETRY |

## What the app will NOT do

- It will never ask for, accept, or store a service-role key.
- It will never run against a backend older than schema v15 (unsafe operations are gated).
- It will never silently retry a balance-changing operation — the offline outbox waits for an explicit RETRY, and idempotency keys make retries safe.
