-- 0015_function_least_privilege.sql
-- Run 9: PostgreSQL grants EXECUTE on new functions to PUBLIC by default.
-- Earlier migrations granted to `authenticated` and revoked from `anon`,
-- but the PUBLIC grant still let unauthenticated callers invoke every RPC
-- (the functions fail closed via caller_user()/my_warehouse_id(), but
-- least privilege demands the call never reach them).
-- This migration revokes PUBLIC execute on all public-schema functions
-- and re-grants to `authenticated` only.
--
-- LIMITATION (PostgreSQL): the default PUBLIC EXECUTE on newly created
-- functions is hardcoded and CANNOT be removed with ALTER DEFAULT
-- PRIVILEGES ... REVOKE (verified on PG 16: the revoke is a no-op).
-- Supabase does not allow event triggers to auto-revoke. Therefore every
-- future migration that creates a function MUST include an explicit
--   REVOKE EXECUTE ON FUNCTION <name>(<args>) FROM PUBLIC;
-- immediately after CREATE. The Run 9 test suite statically checks new
-- migration files for this pattern.
do $$
declare r record;
begin
  for r in
    select p.oid from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public', r.oid::regprocedure);
  end loop;
end $$;

grant execute on all functions in schema public to authenticated;

-- Record this migration in the version history (0014 backfilled 1-14).
insert into public.schema_version_history (version) values (15)
on conflict (version) do nothing;
