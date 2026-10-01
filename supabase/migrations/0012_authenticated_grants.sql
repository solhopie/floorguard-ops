-- 0012_authenticated_grants.sql
-- Run 9: PostgREST serves table reads/writes as the `authenticated` role, so
-- that role needs table privileges. Row-level security policies remain the
-- real enforcement layer (warehouse isolation + role gates); these grants
-- only let PostgREST reach the tables that RLS then filters.
--
-- No grants to `anon`: Shared Pilot requires sign-in for every operation.
-- DELETE is granted but every delete is still denied by RLS (no delete
-- policies exist), matching the app's append-only design.

grant usage on schema public to authenticated;

grant select, insert, update, delete on all tables in schema public to authenticated;

-- sequences (business-number counters and any future serial keys)
grant usage, select on all sequences in schema public to authenticated;

-- Future migrations that add tables must re-run the grants above.
