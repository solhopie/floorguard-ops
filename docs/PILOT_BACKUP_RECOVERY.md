# PILOT BACKUP & RECOVERY — FloorGuard Ops Shared Pilot (v0.9)

Two independent copies protect the pilot: the Supabase database (the system
of record) and each device's on-device snapshot. Back up **both** before the
first real shift and weekly during the pilot.

## 1. Database backup (Supabase — system of record)

### Weekly full backup
1. Supabase dashboard → **Database → Backups** — the project already takes daily automatic backups (retained per your plan). Before the pilot, take a manual snapshot: **Backups → Create backup**.
2. Additionally, keep your own copy with `pg_dump` (needs the database password from step 1 of PILOT_BACKEND_SETUP.md):
   ```bash
   pg_dump "postgresql://postgres:YOUR-DB-PASSWORD@db.YOUR-PROJECT-REF.supabase.co:5432/postgres" \
     --schema=public --data-only --file=floorguard-pilot-$(date +%F).sql
   ```
   Store the file somewhere other than the warehouse (owner's laptop / cloud drive).

### What is covered
All tables: rolls, work orders, assignments, cuts, cycle counts, orders, sales orders, loadouts, receipts, returns, remnants, documents metadata, audit events, and `schema_version_history`.

### What is NOT in the database
History-card **photos** live in the `history-cards` storage bucket. Back them up: **Storage → history-cards →** select all → download, or use the Supabase CLI / S3-compatible API. Do this monthly during the pilot.

## 2. Device backup (on-device snapshot)

Each device keeps a local mirror of the shared dataset plus its offline outbox.

1. On the device: **Settings → EXPORT LOCAL DATA** — saves `floorguard-local-export.json`.
2. Copy the file off the device (email it to yourself, AirDrop, USB).
3. The export contains the warehouse mirror (rolls, work orders, assignments, cuts, counts, sessions, documents, audit events) and employee names/roles. It contains **no passwords and no keys** (the anon key is public by design; the access token is session-scoped and short-lived). Note: pending offline outbox items are stored separately on the device and are NOT included in the export — sync or record them before wiping a device.

## 3. Recovery procedures

### A device is lost / replaced
1. Install/open FloorGuard Ops on the replacement.
2. **Settings → SHARED PILOT** → enter URL + anon key → **SAVE SETTINGS** (backend check must pass).
3. Sign in with the pilot email → **REFRESH NOW** — the full shared dataset re-downloads. Nothing is lost: the backend is the system of record.

### Bad data was entered (wrong count / wrong cut)
1. Do NOT delete rows directly. Every balance change is append-only by design.
2. Correct with the app's own tools: a new cycle count supersedes the bad count; a supervisor can resolve the discrepancy the count creates.
3. The audit trail (`audit_events`) records who did what and when — use History to reconstruct the sequence.

### Database restore (nuclear option — owner only)
1. Stop the pilot: tell all devices to switch to **LOCAL DEMO** (prevents new writes mid-restore).
2. Supabase dashboard → **Database → Backups** → restore the snapshot, or replay your `pg_dump` file into a fresh project and re-run migrations 0001–0015 first.
3. Verify `select max(version) from public.schema_version_history;` → 14.
4. Devices: switch back to **SHARED PILOT** → **REFRESH NOW**.

### Schema downgrade / migration mishap
The app gates on schema v14+. If a migration was applied out of order, the devices will show **BACKEND UPDATE REQUIRED** instead of writing against a half-migrated schema. Fix the migrations, re-run the readiness check — the gate is doing its job.

## 4. Retention during the pilot

- Supabase automatic backups: per plan (confirm retention in Database → Backups).
- Manual `pg_dump`: keep the pre-pilot baseline + weekly copies through the pilot.
- Device exports: keep one per device per week; discard after the pilot closes.
- History-card photos: monthly bucket download.

## 5. What to check monthly

- [ ] A restore was rehearsed at least once (even to a throwaway project).
- [ ] `schema_version_history` still reads 15 (no unrecorded schema edits).
- [ ] Storage bucket is still Private.
- [ ] Only current pilot users are `active` in `public.users`.
