# FloorGuard Ops — Shared Backend (Run 4)

Supabase-compatible backend for multi-device sync. The frontend keeps its
repository abstraction (`repository.js`), so this backend can be swapped
later without touching UI code.

## Architecture

```
FloorGuard Ops (GitHub Pages, static frontend)
        │  PostgREST / Storage REST (anon key, RLS enforced)
        ▼
Supabase project  ──►  PostgreSQL (migrations/ 0001–0007)
                  ──►  Storage bucket `history-cards` (private)
```

* **Reads** go through PostgREST with Row Level Security.
* **Balance changes** go through the `record_cut` / `reserve_inventory`
  Postgres RPCs only — direct `UPDATE` on `rolls` and direct `INSERT` on
  `cut_transactions` are revoked from app roles. Each RPC:
  1. verifies the caller's warehouse membership (`auth.uid()` → `users`),
  2. honors idempotency keys (`client_request_id` — safe retries),
  3. checks the roll `version` the device saw (optimistic concurrency),
  4. writes cut + balance + assignment + history + audit in ONE transaction.
* **History cards** are uploaded to the private `history-cards` bucket at
  `history-cards/<warehouse_id>/<roll_id>/<uuid>.jpg`. The bucket is not
  public and has no update/delete policy — images are immutable.

## Deploy (owner steps)

1. **Create a Supabase project** at https://supabase.com (free tier works
   for the pilot).
2. **Run the migrations** in order, in the Supabase SQL editor (or
   `supabase db push`):
   - `supabase/migrations/0001_core.sql`
   - `supabase/migrations/0002_operations.sql`
   - `supabase/migrations/0003_history_docs.sql`
   - `supabase/migrations/0004_rls.sql`
3. **Seed demo data** (optional): run `supabase/seed.sql`.
4. **Create Auth users** (Authentication → Users) — one per warehouse
   employee, e.g. `marcus@warehouse.local`. Any password scheme works for
   the pilot; use real emails if you want magic links later.
5. **Link each auth user** to its app row:
   ```sql
   update public.users set auth_user_id = '<auth.users.id>'
   where display_name = 'Marcus';
   ```
   Until this link exists, RLS denies that employee all access.
6. **Copy the project credentials**: Project Settings → API →
   `Project URL` and `anon public` key.
7. **Enter them in the app**: FloorGuard Ops → Settings → DATA MODE →
   switch to **Shared Pilot**, paste URL + anon key, SAVE & CONNECT.
   The app stores them in this device's localStorage only (pilot
   convenience, not a vault). The **service-role key is never needed**
   by the frontend and must never be pasted there.

## Data modes

| Mode | `DATA_PROVIDER` | Behavior |
|---|---|---|
| **Local Demo** (default) | `local` | Existing localStorage architecture. Single device. |
| **Shared Pilot** | `shared` | PostgreSQL via Supabase REST. Multi-device. |

Switch in Settings → DATA MODE. The app keeps the local fallback untouched.

## Migration: local → shared

Settings → DATA MODE → **EXPORT LOCAL DATA** downloads a JSON snapshot of
this device. Switch to Shared Pilot, then **IMPORT INTO SHARED BACKEND**
uploads it (warehouses → users → rolls → work orders → assignments →
cuts → counts → history → documents metadata → audit), upserting on stable
IDs so re-imports are safe. Nothing uploads without you pressing the button.

## Security notes (honest)

* This is **architecture preparation, not a certification**. RLS policies
  are written for the four roles (WAREHOUSE_EMPLOYEE, SUPERVISOR, MANAGER,
  ADMIN) and direct balance tampering is revoked at the database level.
* Employees cannot perform admin DB actions through frontend requests:
  admin-only tables/policies require `MANAGER`/`ADMIN` role rows, and the
  anon key alone grants nothing until an auth user is linked.
* History-card images are not publicly enumerable: private bucket,
  warehouse-scoped storage policies, no public URLs.
* What is NOT done in this run: real Supabase Auth sign-in UI in the app
  (the pilot links the existing employee picker to auth users server-side
  via the `auth_user_id` mapping), automated backups/PITR, and a pen test.

## Files

* `migrations/0001_core.sql` — warehouses, users, products, locations,
  rolls (with `version`), work orders + material lines.
* `migrations/0002_operations.sql` — assignments, cuts, cycle-count
  sessions/records, discrepancies, plus `record_cut()` and
  `reserve_inventory()` atomic RPCs.
* `migrations/0003_history_docs.sql` — append-only roll ledger, documents,
  extraction imports, audit trail.
* `migrations/0004_rls.sql` — RLS on all 16 tables, role policies,
  assignment state-machine trigger, revocations, `history-cards` bucket.
* `migrations/0005_cycle_count_rpc.sql` — atomic `record_cycle_count()`
  RPC: count record + MB stamp + PHYSICAL_MEASUREMENT history + audit in one
  transaction; does not bump the optimistic roll version (a measurement is
  not a balance change).
* `migrations/0006_scheduled_jobs.sql` — Run 5: scheduling fields on
  `work_orders` (priority, scheduled_time, on_hold/hold_reason/hold_at/
  hold_by, warehouse_completed_at/by). Readiness stays client-derived;
  work-order audit goes to `audit_events` with entity_type='work_order'.
* `migrations/0007_order_sales_order.sql` — Run 6: order → sales order
  commercial chain. Tables `orders`, `order_items`, `sales_orders`,
  `sales_order_lines` (all RLS-gated; draft editing is manager/admin,
  reads are warehouse-scoped). Atomic RPCs: `submit_sales_order()` —
  creates the sales order + all lines in one transaction, idempotent via
  the `source_order_id` unique key (a retried submit returns the existing
  sales order); `release_sales_order_line()` — creates exactly one work
  order per sales-order line in one transaction, idempotent (a retried
  release returns the existing work order), refuses held/cancelled sales
  orders, and rolls the sales-order status up (OPEN → PARTIALLY_RELEASED
  → RELEASED_TO_WAREHOUSE). Cancellation never deletes work orders.
* `seed.sql` — demo warehouse, users, locations, rolls, work orders,
  plus Run 6 fixtures (ORD-1000 submitted, ORD-1001 draft, SO-100245
  with two lines).
