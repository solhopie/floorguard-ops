# PILOT USERS — FloorGuard Ops Shared Pilot (v0.9)

Create one Auth login per person (dashboard → Authentication → Users → Add user,
confirm the email manually), then link each login to a warehouse row so the
backend knows their warehouse and role:

```sql
insert into public.users (auth_user_id, warehouse_id, display_name, role, active)
values ('PASTE-AUTH-UID-HERE', 'main', 'Marcus', 'MANAGER', true);
```

Valid `role` values (exact spelling): `WAREHOUSE_EMPLOYEE`, `SUPERVISOR`,
`MANAGER`, `ADMIN`.

## Suggested pilot roster

| Person | Auth email | Role | Device | Can do |
|---|---|---|---|---|
| Marcus | marcus@warehouse.com | MANAGER | 1 (primary) | Everything: approvals, overrides, diagnostics, user setup |
| Dana | dana@warehouse.com | WAREHOUSE_EMPLOYEE | 1 or 2 | Counts, cuts, assignments, returns intake |
| Luis | luis@warehouse.com | WAREHOUSE_EMPLOYEE | 2 | Counts, cuts, assignments, returns intake |

Add a `SUPERVISOR` row if someone other than Marcus will approve overrides
during the pilot.

## Role rules the backend enforces (not just the UI)

- **WAREHOUSE_EMPLOYEE**: counts, cuts, reservations, returns intake, loadout execution, remnant assignment when material matches.
- **SUPERVISOR** (+everything above): order submission, sales-order release, loadout completion, receipt receiving, return hold/quarantine/complete, exception resolution, remnant creation, restock, and material-compatibility overrides **with a recorded reason**.
- **MANAGER** (+everything above): scrap, vendor return, return cancel, Pilot Diagnostics.
- **ADMIN** (+everything above): destructive data reset on the device.

Cross-warehouse: Managers and Admins may act across warehouses; employees and
supervisors are confined to their own warehouse by RLS.

## Offboarding a pilot user

```sql
update public.users set active = false where display_name = 'Luis';
```
Then delete or disable the Auth user. Deactivation is immediate: RLS policies
join `public.users` on every request.
